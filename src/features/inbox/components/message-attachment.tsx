"use client";

import { useEffect, useState } from "react";
import {
  FileText,
  Download,
  Music,
  Paperclip,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { MediaMeta } from "@/features/inbox/services/media-handler";

interface MessageAttachmentProps {
  /** Raw media metadata stored in messages.meta */
  media: Record<string, unknown>;
  /** Message type: 'audio' | 'image' | 'document' | 'video' */
  type: string;
}

type MediaKind = "image" | "audio" | "video" | "document" | "unknown";

function categorize(type: string, mimeType?: string): MediaKind {
  if (type === "image") return "image";
  if (type === "audio") return "audio";
  if (type === "video") return "video";
  if (type === "document") return "document";
  // Fallback: infer from mime_type when type is generic
  if (mimeType) {
    const lower = mimeType.toLowerCase();
    if (lower.startsWith("image/")) return "image";
    if (lower.startsWith("audio/")) return "audio";
    if (lower.startsWith("video/")) return "video";
    if (
      lower.includes("pdf") ||
      lower.includes("word") ||
      lower.includes("sheet") ||
      lower.includes("text/")
    )
      return "document";
  }
  return "unknown";
}

function parseMediaMeta(raw: Record<string, unknown>): Partial<MediaMeta> {
  return {
    storage_path:
      typeof raw.storage_path === "string" ? raw.storage_path : undefined,
    mime_type: typeof raw.mime_type === "string" ? raw.mime_type : undefined,
    caption: typeof raw.caption === "string" ? raw.caption : undefined,
    filename: typeof raw.filename === "string" ? raw.filename : undefined,
    transcript: typeof raw.transcript === "string" ? raw.transcript : undefined,
    size_bytes: typeof raw.size_bytes === "number" ? raw.size_bytes : undefined,
  };
}

async function fetchSignedUrl(storagePath: string): Promise<string | null> {
  const res = await fetch("/api/inbox/media-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storagePath }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { url?: string };
  return json.url ?? null;
}

// ─── Sub-renderers ────────────────────────────────────────────────────────────

function ImageAttachment({ url, caption }: { url: string; caption?: string }) {
  return (
    <div className="space-y-1">
      <a href={url} target="_blank" rel="noopener noreferrer" className="block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={caption ?? "Imagen recibida"}
          className="max-h-64 max-w-full rounded-md object-cover"
          loading="lazy"
        />
      </a>
      {caption && (
        <p className="text-xs text-muted-foreground leading-snug">{caption}</p>
      )}
    </div>
  );
}

function AudioAttachment({
  url,
  transcript,
}: {
  url: string;
  transcript?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 min-w-[220px]">
        <Music className="h-4 w-4 shrink-0 text-muted-foreground" />
        <audio controls className="h-8 max-w-full" src={url}>
          Tu navegador no soporta audio.
        </audio>
      </div>
      {transcript && (
        <p className="text-xs text-muted-foreground italic leading-snug">
          {transcript}
        </p>
      )}
    </div>
  );
}

function VideoAttachment({ url }: { url: string }) {
  return (
    <video controls className="max-h-64 max-w-full rounded-md" src={url}>
      Tu navegador no soporta video.
    </video>
  );
}

function DocumentAttachment({
  url,
  filename,
  mimeType,
}: {
  url: string;
  filename?: string;
  mimeType?: string;
}) {
  const displayName = filename ?? mimeType ?? "archivo";
  const isPdf = mimeType?.includes("pdf");
  const Icon = isPdf ? FileText : Paperclip;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      download={filename}
      className={cn(
        "flex items-center gap-2 rounded-lg px-3 py-2 text-sm",
        "bg-muted/50 hover:bg-muted/80 transition-colors",
        "max-w-[280px]",
      )}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate text-foreground">{displayName}</span>
      <Download className="h-3 w-3 shrink-0 text-muted-foreground" />
    </a>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function MessageAttachment({ media, type }: MessageAttachmentProps) {
  const parsed = parseMediaMeta(media);
  const kind = categorize(type, parsed.mime_type);

  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!parsed.storage_path);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    // No media to fetch — `loading` is already initialized to false in this case.
    if (!parsed.storage_path) {
      return;
    }

    // `loading` starts true and `fetchError` false for a message with media,
    // so no synchronous reset is needed before fetching.
    let cancelled = false;

    fetchSignedUrl(parsed.storage_path)
      .then((signedUrl) => {
        if (cancelled) return;
        if (signedUrl) {
          setUrl(signedUrl);
        } else {
          setFetchError(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFetchError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [parsed.storage_path]);

  // Media not yet downloaded from Kapso (storage_path missing)
  if (!parsed.storage_path) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 max-w-[280px]">
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">
          Descargando archivo…
        </span>
      </div>
    );
  }

  // Generating signed URL
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground opacity-70">
        <Loader2 className="h-3 w-3 animate-spin" /> Cargando…
      </div>
    );
  }

  // Error or signed URL unavailable
  if (fetchError || !url) {
    return (
      <div className="flex items-center gap-2 text-xs text-destructive">
        <AlertCircle className="h-3 w-3" />
        <span>No disponible</span>
      </div>
    );
  }

  // Render by media kind
  if (kind === "image") {
    return <ImageAttachment url={url} caption={parsed.caption} />;
  }

  if (kind === "audio") {
    return <AudioAttachment url={url} transcript={parsed.transcript} />;
  }

  if (kind === "video") {
    return <VideoAttachment url={url} />;
  }

  if (kind === "document") {
    return (
      <DocumentAttachment
        url={url}
        filename={parsed.filename}
        mimeType={parsed.mime_type}
      />
    );
  }

  // Fallback for unknown types
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 max-w-[280px] hover:bg-muted/80 transition-colors"
    >
      <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="text-sm text-foreground">[Media]</span>
    </a>
  );
}
