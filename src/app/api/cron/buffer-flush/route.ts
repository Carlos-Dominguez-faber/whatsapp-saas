import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/cron-auth";
import {
  hasTimeToClaim,
  processNextBatch,
  reconcileOrphanedMessages,
} from "@/features/inbox/services/buffer";

// ──────────────────────────────────────────────────────────────────────────────
// Buffer drain — called every minute by pg_cron (job `buffer-flush`, see
// supabase/migrations/20260615000003_enable_pg_cron_pg_net.sql) with
// `Authorization: Bearer ${CRON_SECRET}`. There is no Vercel Cron for this
// route; do not add one.
//
// Each tick drains up to MAX_BATCHES_PER_RUN batches, each of which may cost
// an LLM turn plus tool calls. maxDuration keeps the function alive long
// enough; if it is ever hit, claim_next_batch() reclaims the stale batch after
// its 7-minute lease (always above maxDuration) and counts a retry.
//
// The status is the tick's health, as in cron/automations: 200 when both
// phases (orphan reconciliation, the drain) did their work, 500 with the
// failed phase's code when one couldn't (its lookup or the claim itself
// failed). A batch that failed is per-item work, counted in `failed`, and
// still a 200. pg_net only records the answer (net._http_response): a 500
// triggers no retry, it makes the failure visible.
// ──────────────────────────────────────────────────────────────────────────────

export const maxDuration = 300;

// Max batches to drain per cron tick — protects against burst accumulation
const MAX_BATCHES_PER_RUN = 10;

export async function GET(request: Request): Promise<NextResponse> {
  const startedAt = Date.now();
  if (!isAuthorized(request.headers.get("Authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let recovered = 0;
  let processed = 0;
  let failed = 0;
  const errors: string[] = [];

  // Safety net: inbound messages a persistently failing upsertBatch() left
  // without a batch get one now. Its failure is reported, and the drain (an
  // independent phase) still runs.
  try {
    const reconciled = await reconcileOrphanedMessages();
    recovered = reconciled.recovered;
    if (reconciled.error) errors.push(reconciled.error);
  } catch (err) {
    console.error("[cron/buffer-flush] reconcile threw:", err instanceof Error ? err.message : err);
    errors.push("reconcile_threw");
  }

  // Never claim a batch without time to finish it: a function killed mid-turn
  // leaves the batch stuck for the 7-minute lease.
  try {
    for (
      let i = 0;
      i < MAX_BATCHES_PER_RUN && hasTimeToClaim(startedAt, maxDuration);
      i++
    ) {
      const result = await processNextBatch();
      if (result.processed) {
        processed++;
        continue;
      }
      // The claim itself failed: the tick couldn't get work. Not one more
      // failed batch.
      if (result.phaseError) {
        errors.push(result.phaseError);
        break;
      }
      // A batch that failed is re-queued or dead-lettered by processNextBatch;
      // keep draining the others.
      if (result.error) {
        failed++;
        continue;
      }
      // No more ready batches — stop early.
      break;
    }
  } catch (err) {
    // Codes only, never the exception's text.
    console.error("[cron/buffer-flush] drain threw:", err instanceof Error ? err.message : err);
    errors.push("drain_threw");
  }

  const ok = errors.length === 0;
  return NextResponse.json(
    { ok, processed, recovered, failed, ...(ok ? {} : { errors }) },
    { status: ok ? 200 : 500 },
  );
}
