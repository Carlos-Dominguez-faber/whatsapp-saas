import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/cron-auth";
import {
  BACKFILL_SHARE_MS,
  newRunGuards,
  runBackfillPhase,
  runClassificationPhase,
  type BackfillPhaseResult,
  type ClassificationPhaseResult,
} from "@/features/analytics/services/classify-topics";

// Invariante: RUN_BUDGET_MS < maxDuration < LEASE_SECONDS (180 s, en
// classify-topics.ts) < intervalo de pg_cron (5 min). El intervalo NO es una
// garantía de exclusión (un reintento de net.http_get o una corrida manual
// bastan para solapar dos): la exclusión la dan los leases de las dos fases
// (por conversación y por tema). 100 s leave ~65 s of LLM starts per run (each
// call needs its full 35-40 s floor, see classifyOne).
//
// TURNS (the model is in classify-topics.ts): the backfill of new topics runs
// FIRST, with its own cut at BACKFILL_SHARE_MS; the nightly phase gets the
// rest, so whatever the backfill doesn't use — nothing pending, over the cap,
// a dead key — is not lost. Both phases share the run's guards: a key that
// died in one is dead in the other, and so is the breaker's count.
//
// A halt (the breaker tripped, or our database failed) skips the other phase
// and answers 500 ok:false with the phase's code. `200` with `failed`,
// `deferred` or skipped workspaces is a normal run: those are handled.
export const maxDuration = 120;
export const RUN_BUDGET_MS = 100_000;

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

const skippedPhase = (error: string): ClassificationPhaseResult => ({
  classified: 0, failed: 0, deferred: 0, skipped_workspaces: 0, unavailable_workspaces: 0, halt: false, error,
});

export async function GET(request: Request) {
  if (!isAuthorized(request.headers.get("Authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const start = Date.now();
  const deadline = start + RUN_BUDGET_MS;
  const guards = newRunGuards();
  let phaseFailed = false;

  let backfill: BackfillPhaseResult;
  try {
    backfill = await runBackfillPhase(Math.min(deadline, start + BACKFILL_SHARE_MS), undefined, guards);
    if (backfill.error) phaseFailed = true;
  } catch (err) {
    phaseFailed = true;
    console.error("[cron/classify-topics] backfill phase threw", errName(err));
    backfill = {
      processed: 0, failed: 0, deferred: 0, topics_done: 0, topics_expired: 0,
      skipped_workspaces: 0, unavailable_workspaces: 0, halt: true, error: "threw",
    };
  }

  let classified: ClassificationPhaseResult;
  if (backfill.halt) {
    phaseFailed = true;
    classified = skippedPhase("skipped_after_halt");
  } else {
    try {
      classified = await runClassificationPhase(deadline, undefined, guards);
      if (classified.error) phaseFailed = true;
    } catch (err) {
      phaseFailed = true;
      console.error("[cron/classify-topics] classification phase threw", errName(err));
      classified = { ...skippedPhase("threw"), halt: true };
    }
  }

  return NextResponse.json(
    { ok: !phaseFailed, classified, backfill },
    { status: phaseFailed ? 500 : 200 },
  );
}
