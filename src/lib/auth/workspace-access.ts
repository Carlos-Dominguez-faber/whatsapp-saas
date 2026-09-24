// Shared workspace authorization helpers.
//
// Centralizes the "is this authenticated user an active member of THIS workspace
// (with at least role X)?" check that several API routes were missing — the IDOR
// class of bugs found in the E2E audit (team/tools/integrations).
//
// Uses the RLS-respecting server client (anon key + the caller's cookie session),
// NOT the service-role client: a non-member's membership SELECT returns nothing
// and is correctly treated as "access denied". Mirrors the proven inline pattern
// in src/app/api/workspace/[id]/automations/route.ts, plus the is_active filter
// used in src/app/api/workspace/[id]/agents/route.ts.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export type WorkspaceRole = "admin" | "manager" | "agent" | "viewer";

const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  agent: 1,
  manager: 2,
  admin: 3,
};

type MemberOk = { ok: true; userId: string; role: WorkspaceRole };
type MemberFail = { ok: false; response: NextResponse };

type CheckOk = { ok: true; userId: string; role: WorkspaceRole };
type CheckFail = {
  ok: false;
  status: 401 | 403;
  reason?: "not_member" | "insufficient_role";
};

/**
 * Same check as `requireWorkspaceMember`, without the HTTP framing — for
 * callers that aren't Route Handlers (e.g. Server Actions), which can't
 * return a `NextResponse`.
 *
 * Returns `{ ok: true, userId, role }` on success, or `{ ok: false, status,
 * reason }` where `reason` distinguishes the two 403 cases.
 */
export async function checkWorkspaceMember(
  workspaceId: string,
  opts?: { minRole?: WorkspaceRole },
): Promise<CheckOk | CheckFail> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, status: 401 };
  }

  const { data: member } = await supabase
    .from("memberships")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .eq("is_active", true)
    .maybeSingle();

  if (!member) {
    return { ok: false, status: 403, reason: "not_member" };
  }

  const role = member.role as WorkspaceRole;
  // Object.hasOwn guards against prototype keys: ROLE_RANK is a plain object
  // literal, so ROLE_RANK["constructor"] resolves to Object's constructor
  // function (not undefined) via the prototype chain — a role of literally
  // "constructor" would otherwise get a truthy, non-numeric rank and slip
  // past the `rank === undefined` check below.
  const rank = Object.hasOwn(ROLE_RANK, role) ? ROLE_RANK[role] : undefined;
  const minRank =
    opts?.minRole && Object.hasOwn(ROLE_RANK, opts.minRole)
      ? ROLE_RANK[opts.minRole]
      : undefined;

  // An unrecognized role (typo in the DB, or a role added by a migration
  // this map hasn't caught up with, e.g. "owner") must never fall through as
  // authorized — `undefined < anything` is always false in JS, which used to
  // let it silently bypass the minRole check entirely. Same guard applies to
  // `opts.minRole` itself: a caller that bypasses the WorkspaceRole type (an
  // `any`-typed value from outside this module) must not silently authorize
  // just because the comparison against `undefined` is false either way.
  if (rank === undefined || (opts?.minRole && (minRank === undefined || rank < minRank))) {
    return { ok: false, status: 403, reason: "insufficient_role" };
  }

  return { ok: true, userId: user.id, role };
}

/**
 * Authenticates the caller and verifies they are an ACTIVE member of `workspaceId`.
 * Optionally enforces a minimum role (e.g. "manager" for mutations).
 *
 * Returns `{ ok: true, userId, role }` on success, or `{ ok: false, response }`
 * where `response` is the ready-to-return 401/403 NextResponse.
 *
 * Usage:
 *   const auth = await requireWorkspaceMember(workspaceId, { minRole: "manager" });
 *   if (!auth.ok) return auth.response;
 *   // ...proceed; safe to use the service-role client now.
 */
export async function requireWorkspaceMember(
  workspaceId: string,
  opts?: { minRole?: WorkspaceRole },
): Promise<MemberOk | MemberFail> {
  const result = await checkWorkspaceMember(workspaceId, opts);
  if (result.ok) return result;

  if (result.status === 401) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const message =
    result.reason === "insufficient_role"
      ? "Permisos insuficientes"
      : "Acceso denegado";
  return {
    ok: false,
    response: NextResponse.json({ error: message }, { status: 403 }),
  };
}

type JsonOk<T> = { ok: true; body: T };
type JsonFail = { ok: false; response: NextResponse };

/**
 * Safely parses a JSON request body. Returns a 400 NextResponse on malformed JSON
 * instead of letting `req.json()` throw (which surfaces as a 500).
 *
 * Usage:
 *   const parsed = await readJsonBody(req);
 *   if (!parsed.ok) return parsed.response;
 *   const result = MySchema.safeParse(parsed.body);
 */
export async function readJsonBody<T = unknown>(
  req: Request,
): Promise<JsonOk<T> | JsonFail> {
  try {
    return { ok: true, body: (await req.json()) as T };
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "El cuerpo de la solicitud no es JSON válido" },
        { status: 400 },
      ),
    };
  }
}
