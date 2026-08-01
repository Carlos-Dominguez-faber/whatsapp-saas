import { type NextRequest, NextResponse, after } from "next/server";
import { createClient as createSbClient } from "@supabase/supabase-js";
import {
  verifyKapsoSignature,
  parseInbound,
  parseStatusUpdate,
  parseOutboundEcho,
  isStatusEvent,
  resolveEventName,
} from "@/features/inbox/services/kapso-webhook-handler";
import {
  processInbound,
  processOutboundEcho,
} from "@/features/inbox/services/normalizer";
import { checkRateLimits } from "@/features/inbox/services/cost-tracker";
import {
  upsertBatch,
  processNextBatch,
} from "@/features/inbox/services/buffer";
import {
  downloadAndStoreMedia,
  patchMessageMedia,
} from "@/features/inbox/services/media-handler";
import {
  transcribeAudio,
  describeImage,
} from "@/features/inbox/services/media-understanding";

// Keep the function alive long enough for the best-effort fast path below
// (sleep through the buffer window + AI generation). The cron is the fallback.
export const maxDuration = 60;

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// WH-02: monotonic status order — never go backwards
const STATUS_ORDER = ["queued", "sent", "delivered", "read"] as const;
type OrderedStatus = (typeof STATUS_ORDER)[number];
type MessageStatus = OrderedStatus | "failed";

async function handleStatusUpdate(
  supabase: ReturnType<typeof svc>,
  wamid: string,
  newStatus: string,
): Promise<void> {
  const { data: msg } = await supabase
    .from("messages")
    .select("id, status")
    .eq("wamid", wamid)
    .single();

  // Message not found — can happen for outbound we didn't track
  if (!msg) return;

  const current = msg.status as MessageStatus | null;

  // 'failed' is terminal — always apply regardless of current state
  if (newStatus === "failed") {
    await supabase
      .from("messages")
      .update({ status: "failed" })
      .eq("id", msg.id);
    return;
  }

  // For ordered statuses: only advance, never go back
  const currentIdx = current
    ? STATUS_ORDER.indexOf(current as OrderedStatus)
    : -1;
  const newIdx = STATUS_ORDER.indexOf(newStatus as OrderedStatus);

  if (newIdx > currentIdx) {
    await supabase
      .from("messages")
      .update({ status: newStatus })
      .eq("id", msg.id);
  }
  // else: same or lower status — ignore (monotonic guarantee)
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const rawBody = await request.text();
    // Kapso signs the RAW body with HMAC-SHA256 (hex), no timestamp.
    const sigHeader = request.headers.get("X-Webhook-Signature");

    // E3: per-tenant webhook routing via ?wsid query param. With Kapso this is
    // effectively the only route in, since the payload carries no business phone.
    const wsidParam = request.nextUrl.searchParams.get("wsid");

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // The event name lives in the X-Webhook-Event HEADER. An unbuffered Kapso
    // body has no top-level `type` — only message.type ("text"/"image"/…) — so
    // classifying off the body silently drops every real event.
    const eventName = resolveEventName(
      request.headers.get("X-Webhook-Event"),
      body,
    );

    // WH-02: classify the event. Signature verification MUST happen before we
    // act on EITHER a status update or an inbound message.
    const isStatusUpdate = isStatusEvent(eventName);

    // Kapso identifies the receiving business number by its Meta phone_number_id
    // (there is no `to` field). This is the fallback when ?wsid is absent.
    const phoneNumberId =
      typeof body === "object" && body !== null && "phone_number_id" in body
        ? ((body as { phone_number_id?: unknown }).phone_number_id ?? null)
        : null;
    const phoneNumberIdStr =
      typeof phoneNumberId === "string" && phoneNumberId
        ? phoneNumberId
        : null;

    // Events that carry NO actionable data AND cannot identify a workspace
    // (no wsid, no phone_number_id, not a status update) → harmless early 200.
    if (!isStatusUpdate && !phoneNumberIdStr && !wsidParam) {
      return NextResponse.json({ received: true });
    }

    const supabase = svc();

    type IntegrationRow = {
      workspace_id: string;
      credentials: Record<string, unknown>;
      config: Record<string, unknown>;
    };

    let ws: IntegrationRow | null = null;

    if (wsidParam) {
      // E3: direct lookup by workspace_id — faster, no phone scan needed.
      // Status updates always take this path.
      const { data } = await supabase
        .from("integrations")
        .select("workspace_id, credentials, config")
        .eq("workspace_id", wsidParam)
        .eq("provider", "kapso")
        .eq("enabled", true)
        .single();
      ws = data ?? null;
    } else {
      // Fallback: match the Meta phone_number_id across enabled integrations.
      const { data: integrations } = await supabase
        .from("integrations")
        .select("workspace_id, credentials, config")
        .eq("provider", "kapso")
        .eq("enabled", true)
        .limit(10);

      ws =
        (integrations ?? []).find(
          (i: IntegrationRow) =>
            (i.config as { phone_number_id?: string }).phone_number_id ===
            phoneNumberIdStr,
        ) ?? null;
    }

    // No resolvable workspace → 401. A status update without a resolvable
    // (and below, verified) workspace must NEVER fall through to 200.
    if (!ws) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const creds = ws.credentials as {
      kapso_api_key?: string;
      webhook_signing_secret?: string;
    };

    const webhookSecret = creds.webhook_signing_secret;
    if (!webhookSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // CRITICAL: verify the signature BEFORE acting on ANY event (status or inbound).
    if (!verifyKapsoSignature(rawBody, sigHeader, webhookSecret)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Coexistence: a `whatsapp.message.sent` carrying origin 'business_app' is
    // not a status update — it's a human answering from the WhatsApp Business
    // App on their phone. Record it and hand the conversation to them, before
    // the status branch swallows it as an unknown wamid.
    const echo = parseOutboundEcho(body, eventName);
    if (echo) {
      const result = await processOutboundEcho(ws.workspace_id, echo);
      return NextResponse.json({
        received: true,
        echo: true,
        recorded: result.inserted,
        aiDisabled: result.aiDisabled,
      });
    }

    // WH-02: monotonic status updates — only reached after signature verification.
    if (isStatusUpdate) {
      const statusData = parseStatusUpdate(body, eventName);
      if (statusData) {
        await handleStatusUpdate(supabase, statusData.wamid, statusData.status);
      }
      return NextResponse.json({ received: true });
    }

    const normalized = parseInbound(body, eventName);
    if (!normalized) {
      return NextResponse.json({ received: true });
    }

    // Defence in depth: when routed by ?wsid, make sure the event actually
    // belongs to this workspace's number. Kapso webhooks are per-number, so a
    // mismatch means the wsid and the Kapso webhook config drifted apart.
    const configuredPhoneNumberId = (
      ws.config as { phone_number_id?: string }
    ).phone_number_id;
    if (
      configuredPhoneNumberId &&
      normalized.phoneNumberId &&
      configuredPhoneNumberId !== normalized.phoneNumberId
    ) {
      console.warn(
        "[webhook] phone_number_id mismatch for workspace — check the Kapso webhook URL's ?wsid",
      );
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const workspaceId = ws.workspace_id as string;
    const { contact, conversation, message } = await processInbound(
      workspaceId,
      normalized,
    );

    // Duplicate wamid — already processed. This is also what absorbs Kapso's
    // at-least-once delivery, since its signature carries no anti-replay window.
    if (!message) {
      return NextResponse.json({ received: true, dedup: true });
    }

    // Media handling (download + AI understanding) runs AFTER the response so
    // the webhook stays fast. transcript/description land in meta before the
    // batch is processed, so the agent reads voice notes/images as text.
    const mediaLink = normalized.type !== "text" ? normalized.mediaLink : null;
    const messageId = message.id;
    const conversationId = conversation.id;
    const mediaJob = mediaLink
      ? async () => {
          try {
            const mediaMeta = await downloadAndStoreMedia({
              link: mediaLink,
              // Kapso's media_url embeds a signed token — no API key is sent,
              // and the URL expires, so this must run promptly.
              workspaceId,
              conversationId,
              mimeType: normalized.mediaMime ?? undefined,
              filename: normalized.mediaFilename ?? undefined,
              caption:
                normalized.text && normalized.text !== "[Multimedia]"
                  ? normalized.text
                  : undefined,
              kapsoMediaId: normalized.mediaId ?? undefined,
            });
            if (!mediaMeta) return;

            // Translate voice/image to text so the agent understands them.
            if (normalized.type === "audio" || normalized.type === "voice") {
              // Kapso may have transcribed it already — skip the extra call.
              const transcript =
                normalized.transcript ??
                (await transcribeAudio({
                  storagePath: mediaMeta.storage_path,
                  mimeType: mediaMeta.mime_type,
                  workspaceId,
                }));
              if (transcript) mediaMeta.transcript = transcript;
            } else if (normalized.type === "image") {
              const description = await describeImage({
                storagePath: mediaMeta.storage_path,
                mimeType: mediaMeta.mime_type,
                caption: mediaMeta.caption,
                workspaceId,
              });
              if (description) mediaMeta.description = description;
            }

            await patchMessageMedia(workspaceId, messageId, mediaMeta);
          } catch (mediaErr) {
            console.error(
              "[webhook] media handling failed:",
              mediaErr instanceof Error ? mediaErr.message : "unknown",
            );
          }
        }
      : null;

    // AI is toggled off — still fetch the media so the human agent sees it.
    if (!conversation.ai_enabled) {
      if (mediaJob) after(mediaJob);
      return NextResponse.json({ received: true, ai: false });
    }

    // Rate-limit check — still runs here to avoid buffering rate-limited contacts
    const { allowed, reason } = await checkRateLimits(workspaceId, contact.id);
    if (!allowed) {
      // SEC-09: log only non-sensitive fields (no credentials or contact PII)
      console.warn("[webhook] rate limited:", reason ?? "unknown reason");
      if (mediaJob) after(mediaJob);
      return NextResponse.json({ received: true, rateLimited: true });
    }

    // Buffer the message — AI reply is deferred to the cron job.
    // The silence window is configurable per workspace (Kapso settings).
    const bufferSeconds = Number(
      (ws.config as { buffer_silence_seconds?: number }).buffer_silence_seconds,
    );
    const silenceMs =
      Number.isFinite(bufferSeconds) && bufferSeconds >= 3
        ? Math.min(bufferSeconds, 120) * 1000
        : undefined;

    await upsertBatch({
      workspaceId,
      conversationId: conversation.id,
      messageId: message.id,
      silenceMs,
    });

    // Best-effort fast path: process the batch the moment its buffer window
    // closes, instead of waiting up to ~60s for the next cron tick. Runs after
    // the response is sent. If the function is recycled before it fires, the
    // every-minute cron still picks the batch up — so this only ever speeds
    // things up, never breaks them. A later message extends flush_at, so an
    // early fire simply claims nothing and the latest fire does the work.
    const effectiveSilenceMs = silenceMs ?? 30_000;
    after(async () => {
      // Download + understand media first so the transcript/description is in
      // meta before the batch is consolidated for the agent.
      if (mediaJob) await mediaJob();
      await new Promise((resolve) =>
        setTimeout(resolve, effectiveSilenceMs + 500),
      );
      try {
        await processNextBatch();
      } catch (e) {
        console.error(
          "[webhook] fast-path process error:",
          e instanceof Error ? e.message : "unknown",
        );
      }
    });

    return NextResponse.json({ received: true, buffered: true });
  } catch (err) {
    // SEC-09: never log full error objects — they may contain credentials or raw payloads
    console.error(
      "[webhook] unhandled error:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
