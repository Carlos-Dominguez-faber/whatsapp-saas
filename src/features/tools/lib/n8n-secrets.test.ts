import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTH_HEADER_VALUE, isAllowedAuthHeaderName } from "./n8n-secrets.ts";

test("an auth header value with a line break or control character is refused", () => {
  assert.ok(AUTH_HEADER_VALUE.safeParse("Bearer abc.def-123").success);
  assert.ok(AUTH_HEADER_VALUE.safeParse("Bearer a\tb").success, "a tab is a legal header character");
  for (const bad of ["Bearer x\r\nX-Evil: 1", "x\ny", "x\u0000y", "x\u007fy"]) {
    assert.ok(!AUTH_HEADER_VALUE.safeParse(bad).success, JSON.stringify(bad));
  }
});

test("request-describing header names can't be used for auth", () => {
  assert.ok(isAllowedAuthHeaderName("Authorization"));
  assert.ok(isAllowedAuthHeaderName("X-Api-Key"));
  for (const bad of ["Host", "content-length", "Transfer-Encoding", "Cookie"]) {
    assert.ok(!isAllowedAuthHeaderName(bad), bad);
  }
});
