import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/cron-auth";
import {
  runBackfillPhase,
  runClassificationPhase,
  type BackfillPhaseResult,
  type ClassificationPhaseResult,
} from "@/features/analytics/services/classify-topics";

// Invariante: RUN_BUDGET_MS < maxDuration < intervalo de pg_cron (5 min).
// El intervalo NO es una garantía de exclusión (un reintento de net.http_get o
// una corrida manual bastan para solapar dos): la exclusión la dan los leases
// de las dos fases (por conversación y por tema), que duran
// LEASE_SECONDS (120 s) en classify-topics.ts. Por eso RUN_BUDGET_MS y
// maxDuration tienen que quedar por debajo de ese lease.
//
// Un error de infraestructura —reserva de tokens caída, proveedor del LLM
// caído, RPC de avance rota— sale como 500 ok:false con el código de fase.
// `200` con `failed > 0` queda solo para fallos de conversaciones individuales.
//
// Si la fase 1 devuelve `halt` (no se puede reservar, el proveedor está
// caído, o la base no guarda lo pagado) o lanza (estado desconocido), la fase 2
// NO corre: pagaría otra llamada que tampoco serviría. Se decide por `halt`, no
// comparando códigos de error.
export const maxDuration = 60;
export const RUN_BUDGET_MS = 50_000;

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

export async function GET(request: Request) {
  if (!isAuthorized(request.headers.get("Authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const deadline = Date.now() + RUN_BUDGET_MS;
  let phaseFailed = false;

  let classified: ClassificationPhaseResult;
  try {
    classified = await runClassificationPhase(deadline);
    if (classified.error) phaseFailed = true;
  } catch (err) {
    phaseFailed = true;
    console.error("[cron/classify-topics] classification phase threw", errName(err));
    classified = { classified: 0, failed: 0, skipped_workspaces: 0, halt: true, error: "threw" };
  }

  let backfill: BackfillPhaseResult;
  if (classified.halt) {
    phaseFailed = true;
    backfill = { processed: 0, failed: 0, topics_done: 0, topics_expired: 0, halt: false, error: "skipped_after_halt" };
  } else {
    try {
      backfill = await runBackfillPhase(deadline);
      if (backfill.error) phaseFailed = true;
    } catch (err) {
      phaseFailed = true;
      console.error("[cron/classify-topics] backfill phase threw", errName(err));
      backfill = { processed: 0, failed: 0, topics_done: 0, topics_expired: 0, halt: true, error: "threw" };
    }
  }

  return NextResponse.json(
    { ok: !phaseFailed, classified, backfill },
    { status: phaseFailed ? 500 : 200 },
  );
}
