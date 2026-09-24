import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  readJsonBody,
  requireWorkspaceMember,
} from "@/lib/auth/workspace-access";
import { getSignedUrl } from "@/features/inbox/services/media-handler";

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
// <workspaceId>/<conversationId>/<file> — exactly the shape media-handler writes.
const STORAGE_PATH = new RegExp(`^(${UUID})/(${UUID})/[A-Za-z0-9._-]+$`);

const requestSchema = z.object({
  storagePath: z.string().min(1).max(512).regex(STORAGE_PATH),
});

/**
 * POST /api/inbox/media-url
 *
 * Generates a 1-hour signed URL for a file in the whatsapp-media bucket.
 *
 * getSignedUrl() runs with service role, so the RLS
 * policy on storage.objects never sees this request. The workspace check has
 * to be explicit: the first path segment is the workspace id, and the caller
 * must be an active member of it.
 *
 * Body: { storagePath: string }
 * Response: { url: string }
 */
export async function POST(req: NextRequest) {
  try {
    // 1. Validate body + path shape (rejects traversal and foreign shapes)
    const parsedBody = await readJsonBody(req);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = requestSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Ruta de archivo no válida" },
        { status: 400 },
      );
    }
    const storagePath = parsed.data.storagePath;
    const workspaceId = storagePath.split("/")[0];

    // 2. Auth + membership of the workspace that owns the file
    const auth = await requireWorkspaceMember(workspaceId);
    if (!auth.ok) return auth.response;

    // 3. Generate signed URL (service role, 1 hour TTL)
    const url = await getSignedUrl(storagePath);
    if (!url) {
      return NextResponse.json(
        { error: "No se pudo generar la URL" },
        { status: 404 },
      );
    }

    return NextResponse.json({ url });
  } catch (error) {
    console.error("[POST /api/inbox/media-url]:", error);
    return NextResponse.json(
      { error: "Error interno del servidor" },
      { status: 500 },
    );
  }
}
