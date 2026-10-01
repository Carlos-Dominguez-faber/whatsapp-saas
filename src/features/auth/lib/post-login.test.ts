import assert from "node:assert/strict";
import { test } from "node:test";
import { postLoginPath } from "./post-login.ts";

test("only /probar can be asked for after signing in", () => {
  assert.equal(postLoginPath("/probar"), "/probar");
  for (const next of [null, undefined, "", "/settings", "/probar/../settings", "//evil.example", "https://evil.example/probar", "/probar?x=1"]) {
    assert.equal(postLoginPath(next), "/inbox", String(next));
  }
});
