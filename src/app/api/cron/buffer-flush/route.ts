import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
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
  const startedAt = Date.now();
  if (!isAuthorized(request.headers.get("Authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Safety net: inbound messages a persistently failing upsertBatch() left
  // without a batch get one now.
  const recovered = await reconcileOrphanedMessages();

  const results: Array<{ processed: boolean; error?: string }> = [];

  // Never claim a batch without time to finish it: a function killed mid-turn
  // leaves the batch stuck for the 7-minute lease.
  for (
    let i = 0;
    i < MAX_BATCHES_PER_RUN && hasTimeToClaim(startedAt, maxDuration);
    i++
  ) {
    const result = await processNextBatch();
    results.push(result);

    // No more ready batches — stop early. A batch that failed is re-queued
    // or dead-lettered by processNextBatch; keep draining the others.
    if (!result.processed && !result.error) break;
  }

  const processedCount = results.filter((r) => r.processed).length;

  return NextResponse.json({ ok: true, processed: processedCount, recovered });
}
