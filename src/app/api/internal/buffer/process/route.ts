import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient as createSbClient } from "@supabase/supabase-js";
import { processNextBatch } from "@/features/inbox/services/buffer";

// One targeted batch = one LLM turn + tools. Same budget as the cron.
export const maxDuration = 300;

// ──────────────────────────────────────────────────────────────────────────────
// SEC-05: Internal buffer process endpoint
//
// Protected via HMAC-SHA256 of the raw request body with BUFFER_PROCESS_SECRET.
// Header: Authorization: Bearer {hmac-hex}
//
// Used for:
//   - Targeted testing: POST { batchId: "..." } to process a specific batch
//   - General processing: POST {} or POST with no body to process next ready batch
//
// workspace_id is NEVER trusted from the request body — always read server-side.
// ──────────────────────────────────────────────────────────────────────────────

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

function verifyHmac(rawBody: string, providedSig: string): boolean {
  const secret = process.env.BUFFER_PROCESS_SECRET;
  if (!secret) {
    console.error("[internal/buffer/process] BUFFER_PROCESS_SECRET is not set");
    return false;
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

  // Both buffers must be the same length for timingSafeEqual
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(providedSig);

  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, providedBuf);
}

export async function POST(request: Request): Promise<NextResponse> {
  // ── 1. Read raw body for HMAC verification ────────────────────────────────
  const rawBody = await request.text();
  const authHeader = request.headers.get("Authorization") ?? "";
  const providedSig = authHeader.replace("Bearer ", "");

  if (!providedSig) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!verifyHmac(rawBody, providedSig)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── 2. Parse optional batchId from body ───────────────────────────────────
  let batchId: string | undefined;
  if (rawBody.trim()) {
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      if (typeof parsed.batchId === "string") {
        batchId = parsed.batchId;
      }
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  // ── 3a. Specific batch requested ──────────────────────────────────────────
  if (batchId) {
    const supabase = svc();

    // Validate batch exists and is in a processable state
    // workspace_id is read from DB — never from request body
    const { data: batch, error: batchError } = await supabase
      .from("message_batches")
      .select("id, workspace_id, status")
      .eq("id", batchId)
      // Only a batch nobody holds can be re-armed. Reviving one in
      // 'processing' would let claim_next_batch() hand it to a second worker
      // while the first is still generating → double reply.
      .eq("status", "buffering")
      .maybeSingle();

    if (batchError) {
      console.error(
        "[internal/buffer/process] batch lookup error:",
        batchError,
      );
      return NextResponse.json(
        { error: "Failed to look up batch" },
        { status: 500 },
      );
    }

    if (!batch) {
      return NextResponse.json(
        { error: "Batch not found or not in a processable state" },
        { status: 404 },
      );
    }

    // Set flush_at = now so processNextBatch can claim it immediately via the
    // RPC. The UPDATE repeats the status guard: between the SELECT above and
    // this write the cron may have claimed the batch, and re-arming it then
    // would hand it to a second worker → double reply.
    const { data: rearmed, error: rearmError } = await supabase
      .from("message_batches")
      .update({
        flush_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId)
      .eq("workspace_id", batch.workspace_id) // explicit workspace guard
      .eq("status", "buffering")
      .select("id");

    if (rearmError) {
      console.error("[internal/buffer/process] batch re-arm error:", rearmError);
      return NextResponse.json(
        { error: "No se pudo preparar el lote" },
        { status: 500 },
      );
    }

    if (!rearmed || rearmed.length === 0) {
      return NextResponse.json(
        { error: "El lote ya está siendo procesado" },
        { status: 409 },
      );
    }
  }

  // ── 3b. Process next ready batch (or the one we just primed above) ────────
  const result = await processNextBatch();

  if (result.error) {
    console.error("[internal/buffer/process] processing error:", result.error);
  }

  return NextResponse.json({
    ok: true,
    processed: result.processed,
    batchId: batchId ?? undefined,
    ...(result.error ? { error: "No se pudo procesar el lote" } : {}),
  });
}
