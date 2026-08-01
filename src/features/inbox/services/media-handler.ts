import { createClient as createSbClient } from "@supabase/supabase-js";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

const ALLOWED_KAPSO_HOST = "api.kapso.ai";
const BUCKET = "whatsapp-media";

/** MIME type → file extension map */
const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "txt",
};

function extensionFor(mime: string): string {
  const lower = mime.toLowerCase().split(";")[0].trim();
  return MIME_EXTENSIONS[lower] ?? "bin";
}

/** Metadata stored in messages.meta after a successful download */
export interface MediaMeta {
  storage_path: string;
  mime_type: string;
  kapso_media_id?: string;
  /** Caption from image / video payloads */
  caption?: string;
  /** Original filename from document payloads */
  filename?: string;
  size_bytes?: number;
  /** Verbatim transcript filled by media-understanding for audio/voice notes */
  transcript?: string;
  /** Short AI description filled by media-understanding for images */
  description?: string;
}

export interface DownloadAndStoreOptions {
  /**
   * Kapso media download URL (must be on api.kapso.ai — SEC-08). The signed
   * token is embedded in the URL and EXPIRES, so pass it straight from the
   * webhook payload — never a value read back out of storage.
   */
  link: string;
  /** Forge workspace ID used as first path segment in storage */
  workspaceId: string;
  /** Conversation ID used as second path segment in storage */
  conversationId: string;
  /** MIME type declared in the webhook payload */
  mimeType?: string;
  /** Original filename for documents */
  filename?: string;
  /** Caption text for images / videos */
  caption?: string;
  /** Meta media ID from the payload */
  kapsoMediaId?: string;
}

/**
 * SEC-08: Validates that the URL host is exactly api.kapso.ai.
 * Returns false on any parse error.
 */
export function validateKapsoUrl(url: string): boolean {
  try {
    return new URL(url).hostname === ALLOWED_KAPSO_HOST;
  } catch {
    return false;
  }
}

/**
 * Downloads a media file from Kapso and stores it in the whatsapp-media
 * Supabase Storage bucket.
 *
 * Storage path: {workspaceId}/{conversationId}/{timestamp}-{filename}.{ext}
 *
 * Returns null when:
 * - The URL fails SEC-08 host validation
 * - The Kapso download request fails (non-2xx)
 * - The Supabase upload fails
 */
export async function downloadAndStoreMedia(
  opts: DownloadAndStoreOptions,
): Promise<MediaMeta | null> {
  // SEC-08: block requests to non-Kapso hosts
  if (!validateKapsoUrl(opts.link)) {
    console.error(
      "[media-handler] SEC-08 violation — URL host is not api.kapso.ai:",
      opts.link,
    );
    return null;
  }

  // Download from Kapso. NO X-API-Key here: the download URL is pre-signed and
  // carries its own token — and it expires, so a 401/403 usually means the URL
  // sat around too long rather than that the credentials are wrong.
  let response: Response;
  try {
    response = await fetch(opts.link);
  } catch (err) {
    console.error("[media-handler] fetch failed:", err);
    return null;
  }

  if (!response.ok) {
    console.error(
      `[media-handler] Kapso download returned ${response.status} for ${opts.link}`,
    );
    return null;
  }

  // Prefer Content-Type from the response; fall back to declared mimeType
  const contentType = response.headers.get("content-type");
  const mimeType =
    contentType?.split(";")[0].trim() ||
    opts.mimeType ||
    "application/octet-stream";

  const buffer = await response.arrayBuffer();

  // Build storage path
  const ext = extensionFor(mimeType);
  const safeName = (opts.filename ?? "media").replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `${opts.workspaceId}/${opts.conversationId}/${Date.now()}-${safeName}.${ext}`;

  // Upload to Supabase Storage
  const supabase = svc();
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, new Uint8Array(buffer), {
      contentType: mimeType,
      upsert: false,
    });

  if (uploadError) {
    console.error(
      "[media-handler] storage upload failed:",
      uploadError.message,
    );
    return null;
  }

  const meta: MediaMeta = {
    storage_path: storagePath,
    mime_type: mimeType,
    size_bytes: buffer.byteLength,
  };

  if (opts.kapsoMediaId) meta.kapso_media_id = opts.kapsoMediaId;
  if (opts.caption) meta.caption = opts.caption;
  if (opts.filename) meta.filename = opts.filename;

  return meta;
}

/**
 * Creates a 1-hour signed URL for a media file stored in whatsapp-media.
 * Returns null on error.
 */
export async function getSignedUrl(
  storagePath: string,
): Promise<string | null> {
  const supabase = svc();
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, 3600);

  if (error) {
    console.error(
      "[media-handler] createSignedUrl failed:",
      error.message,
      storagePath,
    );
    return null;
  }

  return data?.signedUrl ?? null;
}

/**
 * Updates messages.meta with MediaMeta after a successful download.
 * Intended to run fire-and-forget after processInbound().
 */
export async function patchMessageMedia(
  workspaceId: string,
  messageId: string,
  mediaMeta: MediaMeta,
): Promise<void> {
  const supabase = svc();
  const { error } = await supabase
    .from("messages")
    .update({ meta: mediaMeta })
    .eq("id", messageId)
    .eq("workspace_id", workspaceId);

  if (error) {
    console.error(
      "[media-handler] patchMessageMedia failed:",
      error.message,
      messageId,
    );
  }
}
