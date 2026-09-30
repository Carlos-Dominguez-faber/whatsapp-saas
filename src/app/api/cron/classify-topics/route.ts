import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/cron-auth";
import {
  BACKFILL_SHARE_MS,
  hasPendingBackfill,
  runBackfillPhase,
  runClassificationPhase,
  type BackfillPhaseResult,
  type ClassificationPhaseResult,
} from "@/features/analytics/services/classify-topics";

// Invariante: RUN_BUDGET_MS < maxDuration < LEASE_SECONDS (180 s, en
// classify-topics.ts) < intervalo de pg_cron (5 min). El intervalo NO es una
// garantía de exclusión (un reintento de net.http_get o una corrida manual
// bastan para solapar dos): la exclusión la dan los leases de las dos fases
// (por conversación y por tema). Por eso RUN_BUDGET_MS y maxDuration tienen
// que quedar por debajo de ese lease. 100 s leave ~65 s of LLM starts per run
// (each call needs its full 35-40 s floor, see classifyOne); with 50 s only
// 15 s were usable.
//
// A single workspace whose key or provider fails is skipped by the phases;
// un error de infraestructura —reserva de tokens caída, la misma falla del
// proveedor en dos workspaces, RPC de avance rota— sale como 500 ok:false con
// el código de fase. `200` con `failed > 0` queda solo para fallos de
// conversaciones individuales.
//
// Si la fase 1 devuelve `halt` o lanza (estado desconocido), la fase 2 NO
// corre: pagaría otra llamada que tampoco serviría. Se decide por `halt`, no
// comparando códigos de error. When a topic waits for its backfill, phase 1
// stops BACKFILL_SHARE_MS early so the backfill gets its turn every run.
export const maxDuration = 120;
export const RUN_BUDGET_MS = 100_000;

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

export async function GET(request: Request) {
  if (!isAuthorized(request.headers.get("Authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const deadline = Date.now() + RUN_BUDGET_MS;
  let phaseFailed = false;

  let backfillWaiting = false;
  try {
    backfillWaiting = await hasPendingBackfill(deadline);
  } catch {
    backfillWaiting = false;
  }

  let classified: ClassificationPhaseResult;
  try {
    classified = await runClassificationPhase(backfillWaiting ? deadline - BACKFILL_SHARE_MS : deadline);
    if (classified.error) phaseFailed = true;
  } catch (err) {
    phaseFailed = true;
    console.error("[cron/classify-topics] classification phase threw", errName(err));
    classified = { classified: 0, failed: 0, skipped_workspaces: 0, unavailable_workspaces: 0, halt: true, error: "threw" };
  }

  let backfill: BackfillPhaseResult;
  if (classified.halt) {
    phaseFailed = true;
    backfill = { processed: 0, failed: 0, topics_done: 0, topics_expired: 0, unavailable_workspaces: 0, halt: false, error: "skipped_after_halt" };
  } else {
    try {
      backfill = await runBackfillPhase(deadline);
      if (backfill.error) phaseFailed = true;
    } catch (err) {
      phaseFailed = true;
      console.error("[cron/classify-topics] backfill phase threw", errName(err));
      backfill = { processed: 0, failed: 0, topics_done: 0, topics_expired: 0, unavailable_workspaces: 0, halt: true, error: "threw" };
    }
  }

  return NextResponse.json(
    { ok: !phaseFailed, classified, backfill },
    { status: phaseFailed ? 500 : 200 },
  );
}
