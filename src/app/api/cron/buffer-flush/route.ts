import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
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

function isAuthorized(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  // Fail closed: a missing secret must never turn into `Bearer undefined`.
  if (!secret || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const provided = Buffer.from(header);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAuthorized(request.headers.get("Authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Reconciliation safety net — retries inbound messages orphaned by a
  // persistently failing upsertBatch() call.
  const recovered = await reconcileOrphanedMessages();

  const results: Array<{ processed: boolean; error?: string }> = [];

  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const result = await processNextBatch();
    results.push(result);

    // No more ready batches — stop early
    if (!result.processed) break;
  }

  const processedCount = results.filter((r) => r.processed).length;

  return NextResponse.json({ ok: true, processed: processedCount, recovered });
}
