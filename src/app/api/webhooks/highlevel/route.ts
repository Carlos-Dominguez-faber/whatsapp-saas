/**
 * POST /api/webhooks/highlevel?wsid=<workspaceId>&token=<perWorkspaceSecret>
 * Receives contact create/update events from HighLevel.
 *
 * Auth: per-workspace token in the URL, constant-time compared against
 * integrations.credentials.highlevel_webhook_secret. The workspace is the
 * source of truth (wsid query param), not the payload locationId.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createClient as createSbClient } from "@supabase/supabase-js";
import { syncContactFromHL } from "@/features/inbox/services/highlevel-client";
import { decryptCredentials } from "@/shared/lib/integration-secrets";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

interface HLWebhookBody {
  type?: string;
  locationId?: string;
  // Contact id field name varies across HL webhook versions
  id?: string;
  contactId?: string;
  contact?: { id?: string };
}

interface HLIntegrationRow {
  credentials: { highlevel_webhook_secret?: string } | null;
  config: { location_id?: string } | null;
}

/** Constant-time string compare; mismatched lengths fail without leaking timing. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function POST(req: NextRequest) {
  let body: HLWebhookBody;
  try {
    body = (await req.json()) as HLWebhookBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // --- Auth gate: per-workspace token in the URL (before any DB access) ---
  const wsid = req.nextUrl.searchParams.get("wsid");
  const token = req.nextUrl.searchParams.get("token");

  if (!wsid || !token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = svc();
  const { data: integration, error: integrationError } = await supabase
    .from("integrations")
    .select("credentials,config")
    .eq("workspace_id", wsid)
    .eq("provider", "highlevel")
    .eq("enabled", true)
    .single();

  if (integrationError || !integration) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { credentials } = integration as HLIntegrationRow;
  const decrypted = await decryptCredentials(credentials, wsid, "highlevel");
  const secret = decrypted.highlevel_webhook_secret as string | undefined;

  if (!secret || !safeEqual(token, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // --- Authorized: process the event (wsid is the source of truth) ---
  const eventType = body.type ?? "";

  // Only process contact events
  if (!eventType.startsWith("Contact")) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  // Extract HL contact id (field differs by event type)
  const hlContactId = body.contactId ?? body.id ?? body.contact?.id ?? null;

  if (!hlContactId) {
    return NextResponse.json(
      { error: "Could not determine HL contact id from payload" },
      { status: 400 },
    );
  }

  try {
    await syncContactFromHL(wsid, hlContactId);
  } catch (err) {
    console.error("[HL webhook] syncContactFromHL failed:", err);
    // Return 200 so HL does not retry — error is logged for investigation
    return NextResponse.json({ ok: true, synced: false });
  }

  return NextResponse.json({ ok: true, synced: true });
}
