import { NextResponse } from "next/server";
import { scanTimeTriggers } from "@/features/automations/services/scan-time";
import { expandAutomationEvents } from "@/features/automations/services/expand";
import { drainAutomationRuns } from "@/features/automations/services/executor";
import { isAuthorized } from "@/lib/cron-auth";

// ──────────────────────────────────────────────────────────────────────────────
// Motor de automatizaciones — lo llama pg_cron cada minuto (job `automations`,
// ver supabase/cron/schedule-automations.sql) con
// `Authorization: Bearer ${CRON_SECRET}`. No hay Vercel Cron para esta ruta; no
// agregar uno: sería un segundo disparador.
//
// Cada tick hace tres cosas en orden: 0) escanea los triggers por TIEMPO
// (`appointment_upcoming`) e inserta los eventos que le tocan en
// `automation_events`, 1) expande TODOS los eventos pendientes —los que puso el
// scan y los que dejaron los triggers de Postgres— a filas de
// `automation_runs`, 2) reclama y ejecuta hasta MAX_RUNS_PER_TICK filas, en
// round-robin por workspace (el orden lo pone la RPC, no esta ruta). Cada
// ejecución puede mandar un WhatsApp; el presupuesto de 50 s se fija ACÁ, antes
// del scan, y cubre LAS TRES ETAPAS. Si aun así se corta, el reclamo de
// atascadas de claim_next_automation_run() retoma las filas a los 7 minutos.
//
// El trío de tiempos es deliberado y va junto:
//   RUN_BUDGET_MS 50 s  <  maxDuration 60 s  =  intervalo del cron 60 s
// Lo único estrictamente menor es el presupuesto de trabajo: el techo de la
// función IGUALA al intervalo, a propósito. Con un techo de varios minutos
// contra un cron de un minuto, un tick lento se solaparía con los siguientes.
// El drenaje corta a los 50 s y deja el resto al tick siguiente, así que en
// régimen normal no hay solape; y si igual se solapan, es inocuo (FOR UPDATE
// SKIP LOCKED en el reclamo, UNIQUE (rule_id, event_id) en la expansión). Lo
// que NO hay que hacer es subir maxDuration por encima del intervalo: eso
// convierte el solape en el caso normal.
//
// pg_net es ASÍNCRONO: cron.job_run_details solo dice que el net.http_get se
// encoló, nunca si esta ruta respondió. El resultado observable está en
// net._http_response (status_code, content); ver
// supabase/cron/schedule-automations.sql.
// ──────────────────────────────────────────────────────────────────────────────

export const maxDuration = 60;

/** Tope de filas por tick. Protege del acaparamiento entre tenants junto al
 *  round-robin de la RPC. */
const MAX_RUNS_PER_TICK = 20;

/**
 * Presupuesto de la corrida COMPLETA (expansión + drenaje), no del drenaje
 * solo. Con el presupuesto contando desde dentro del drenaje, una expansión
 * lenta permitía más trabajo total que el maxDuration y la función moría a
 * mitad de una fila, dejándola 'processing' hasta que venciera el lease.
 *
 * 50 s y no más: tiene que caber DENTRO del intervalo de un minuto del job de
 * pg_cron, con margen para el arranque en frío de la función.
 */
export const RUN_BUDGET_MS = 50_000;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAuthorized(request.headers.get("Authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // El reloj arranca ACÁ, no dentro del drenaje: lo que se coma el scan o la
  // expansión sale del mismo presupuesto. Instante absoluto, para no tener que
  // restar nada más abajo.
  const deadline = Date.now() + RUN_BUDGET_MS;

  // Fase 0: triggers por TIEMPO. Nunca lanza por
  // contrato (mismo invariante que expand.ts) — el try/catch es la red por si
  // alguna vez lo hace. Si la fase se cae, el resto del tick (expansión +
  // drenaje) igual tiene que correr: por eso NO se relanza, se guarda como
  // código y sigue.
  let phaseFailed = false;
  let scanned: { events: number; errors: number; error?: string } = {
    events: 0,
    errors: 0,
  };
  try {
    scanned = await scanTimeTriggers(deadline);
    if (scanned.error) phaseFailed = true;
  } catch (err) {
    console.error(
      "[cron/automations] scan-time error:",
      err instanceof Error ? err.message : err,
    );
    phaseFailed = true;
    scanned = { events: 0, errors: 1, error: "scan_time_failed" };
  }

  // La expansión solo encola. Si se cae, la cola ya expandida igual tiene que
  // ejecutarse: son dos etapas independientes. `expandAutomationEvents` no
  // lanza por contrato, pero el try/catch es la red por si alguna vez lo hace:
  // un tick sin ejecutar filas listas es peor que un contador en 1.
  //
  // `phaseFailed` es lo único que decide el código HTTP: cuenta FASES caídas —
  // las que lanzaron y también las que devolvieron su
  // fallo como dato (`scanned.error`, `expanded.error`, `executed.error`). No
  // cuenta los contadores de error por fila (`expanded.errors`,
  // `executed.failed`), que son trabajo normal y siguen dando 200. Ya viene en
  // `false` desde la fase 0; acá se sigue acumulando, nunca se reinicia.
  let expanded: { events: number; runs: number; errors: number; error?: string } = {
    events: 0,
    runs: 0,
    errors: 0,
  };
  try {
    expanded = await expandAutomationEvents(deadline);
    // La expansión no lanza por contrato: cuando su fase se cae (no pudo crear
    // el cliente, no pudo escanear los workspaces pendientes) lo devuelve como
    // código y hay que leerlo, o el tick firma como sano sin haber expandido.
    if (expanded.error) phaseFailed = true;
  } catch (err) {
    // El detalle técnico se registra server-side y NO viaja en la respuesta.
    console.error(
      "[cron/automations] expand error:",
      err instanceof Error ? err.message : err,
    );
    phaseFailed = true;
    expanded = { events: 0, runs: 0, errors: 1, error: "expand_threw" };
  }

  // Si la expansión se comió el presupuesto, esto devuelve el tally en ceros sin
  // reclamar nada — que es lo correcto: reclamar y no ejecutar dejaría filas
  // 'processing' esperando a que venza el lease.
  //
  // Igual que la expansión, `drainAutomationRuns` va cubierto acá — si lanza
  // (por ejemplo, `svc()` sin la env var), no mata el GET entero: el reporte de la expansión (que ya está confirmada en
  // base) no se pierde, y el drenaje queda marcado como fallado con un CÓDIGO,
  // nunca con el mensaje de la excepción.
  let executed: Awaited<ReturnType<typeof drainAutomationRuns>> & { error?: string };
  try {
    executed = await drainAutomationRuns(MAX_RUNS_PER_TICK, deadline);
    // Idem: la RPC del claim puede DEVOLVER error en vez de lanzar. El tally de
    // los runs que sí se ejecutaron se conserva; lo que cambia es el estado.
    if (executed.error) phaseFailed = true;
  } catch (err) {
    console.error(
      "[cron/automations] drain error:",
      err instanceof Error ? err.message : err,
    );
    phaseFailed = true;
    executed = { done: 0, failed: 0, skipped: 0, retry: 0, lost: 0, error: "drain_threw" };
  }

  // El catch de arriba es la red que evita que la ruta se cuelgue, pero no
  // puede firmar como sano un tick que no ejecutó nada. `200` + `ok:true` es LA
  // definición de tick sano: si una fase se cayó —lanzando o devolviendo su
  // código—, la respuesta lo dice con un 500 y `ok:false`, y el body conserva el
  // código por fase (nunca el mensaje de la excepción ni el de PostgREST)
  // junto al tally de lo que el tick sí alcanzó a hacer. Un no-200 no dispara
  // reintento: pg_net solo registra la respuesta en net._http_response y no hay
  // Vercel Cron para esta ruta.
  return NextResponse.json(
    { ok: !phaseFailed, scanned, expanded, executed },
    { status: phaseFailed ? 500 : 200 },
  );
}
