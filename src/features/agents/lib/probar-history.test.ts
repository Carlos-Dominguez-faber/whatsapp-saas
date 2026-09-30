import assert from "node:assert/strict";
import { test } from "node:test";
import {
  probarHistory,
  PROBAR_MAX_CHARS,
  PROBAR_MAX_MESSAGE_CHARS,
  PROBAR_MAX_MESSAGES,
  type ProbarMsg,
} from "./probar-history.ts";

const turn = (i: number, len = 10): ProbarMsg => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: String(i).padEnd(len, "x"),
});

test("keeps the newest turns within the message cap", () => {
  const msgs = Array.from({ length: 25 }, (_, i) => turn(i));
  const kept = probarHistory(msgs);
  assert.equal(kept.length, PROBAR_MAX_MESSAGES);
  assert.equal(kept.at(-1)?.content, msgs.at(-1)?.content);
  assert.equal(kept[0].content, msgs[5].content);
});

test("keeps the newest turns within the character cap", () => {
  const msgs = Array.from({ length: 12 }, (_, i) => turn(i, 900));
  const kept = probarHistory(msgs);
  assert.ok(kept.reduce((n, m) => n + m.content.length, 0) <= PROBAR_MAX_CHARS);
  assert.equal(kept.length, 8);
  assert.equal(kept.at(-1)?.content, msgs.at(-1)?.content);
});

test("a long answer is cut to what the route accepts per message", () => {
  const kept = probarHistory([turn(0), { role: "assistant", content: "y".repeat(3_000) }, turn(2)]);
  assert.equal(kept[1].content.length, PROBAR_MAX_MESSAGE_CHARS);
});

test("REVIEW M5: an empty turn never goes back as history", () => {
  const kept = probarHistory([
    { role: "user", content: "hola" },
    { role: "assistant", content: "  " },
    { role: "user", content: "¿sigues ahí?" },
  ]);
  assert.deepEqual(kept.map((m) => m.content), ["hola", "¿sigues ahí?"]);
});
