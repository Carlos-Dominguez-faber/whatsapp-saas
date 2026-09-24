import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/cron-auth";
import {
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
// enough; if it is ever hit, claim_next_batch() re-claims the stale batch and
// counts a retry (20260902000000_claim_next_batch_counts_stale_retries).
// ──────────────────────────────────────────────────────────────────────────────

export const maxDuration = 300;

// Max batches to drain per cron tick — protects against burst accumulation
const MAX_BATCHES_PER_RUN = 10;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAuthorized(request.headers.get("Authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let recovered = 0;
  let processed = 0;
  // A batch that came back with an `error` is NOT the same case as "no batches
  // left", and without this counter the two look identical from the outside
  // ({ok:true, processed:0}). It travels as a COUNT: the error text stays in the
  // server log, never in the body.
  let failed = 0;
  let error: string | undefined;

  try {
    // Reconciliation safety net — retries inbound messages orphaned by a
    // persistently failing upsertBatch() call.
    //
    // A phase that fell over reports it as DATA, not by throwing — throwing
    // here would skip the drain loop below, which is an independent phase and
    // must still run. The drain's own tally is preserved either way.
    const reconciled = await reconcileOrphanedMessages();
    recovered = reconciled.recovered;
    if (reconciled.error) error = reconciled.error;

    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      const result = await processNextBatch();
      if (result.processed) {
        processed++;
        continue;
      }
      // The claim RPC itself failing is not a per-item failure: the tick could
      // not even get work, so it answers 500 with the phase code instead of
      // being counted as one more failed batch.
      if (result.phaseError) {
        error = result.phaseError;
        break;
      }
      // No more ready batches — stop early. A failing one also stops the tick,
      // but it has to be visible.
      if (result.error) failed++;
      break;
    }
  } catch (err) {
    // Twin of cron/automations: the net keeps the route from dying with a
    // bodyless 500, but a tick that threw cannot answer with the healthy tick's
    // status. Codes only, never the exception message. A non-200 triggers no
    // retry: pg_net just records the response and there is no Vercel Cron here.
    console.error(
      "[cron/buffer-flush] tick error:",
      err instanceof Error ? err.message : err,
    );
    error = "tick_threw";
  }

  return NextResponse.json(
    { ok: !error, processed, recovered, failed, ...(error ? { error } : {}) },
    { status: error ? 500 : 200 },
  );
}
