import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { NextRequest, NextResponse } from "next/server";

const memberCalls: unknown[] = [];
let memberResult: unknown = { ok: true, userId: "user_1", role: "viewer" };
mock.module("@/lib/auth/workspace-access.ts", {
  exports: {
    requireWorkspaceMember: async (...args: unknown[]) => {
      memberCalls.push(args);
      return memberResult;
    },
    readJsonBody: async (req: Request) => ({ ok: true, body: await req.json() }),
  },
});

const signedCalls: string[] = [];
mock.module("@/features/inbox/services/media-handler.ts", {
  exports: {
    getSignedUrl: async (path: string) => {
      signedCalls.push(path);
      return `https://signed.example/${path}`;
    },
  },
});

const { POST } = await import("./route.ts");

const WS_A = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";

function makeReq(body: unknown) {
  return new NextRequest("http://localhost/api/inbox/media-url", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

test("checks membership of the workspace encoded in the path before signing", async () => {
  memberCalls.length = 0;
  signedCalls.length = 0;
  memberResult = { ok: true, userId: "user_1", role: "viewer" };
  const path = `${WS_A}/${CONV}/1725000000000-audio.ogg`;
  const res = await POST(makeReq({ storagePath: path }));
  assert.equal(res.status, 200);
  assert.deepEqual(memberCalls[0], [WS_A]);
  assert.deepEqual(signedCalls, [path]);
});

test("403 and no signed URL when the caller is not a member of that workspace", async () => {
  signedCalls.length = 0;
  memberResult = {
    ok: false,
    response: NextResponse.json({ error: "Acceso denegado" }, { status: 403 }),
  };
  const res = await POST(makeReq({ storagePath: `${WS_A}/${CONV}/1725000000000-doc.pdf` }));
  assert.equal(res.status, 403);
  assert.equal(signedCalls.length, 0);
});

test("400 on a path that does not look like <workspace>/<conversation>/<file>", async () => {
  signedCalls.length = 0;
  memberResult = { ok: true, userId: "user_1", role: "viewer" };
  for (const bad of ["../etc/passwd", `${WS_A}/x.pdf`, `${WS_A}/${CONV}/../../a.pdf`, "not-a-uuid/x/y.pdf"]) {
    const res = await POST(makeReq({ storagePath: bad }));
    assert.equal(res.status, 400, `expected 400 for ${bad}`);
  }
  assert.equal(signedCalls.length, 0);
});
