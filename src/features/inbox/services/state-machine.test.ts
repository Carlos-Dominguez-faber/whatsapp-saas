import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canTransition,
  transition,
  aiShouldRespond,
  detectsHandoffTrigger,
  TransitionError,
  type ConversationState,
} from "./state-machine.ts";

test("canTransition allows a transition listed in the table", () => {
  assert.equal(canTransition("ai_active", "human_active"), true);
});

test("canTransition rejects a transition not listed in the table", () => {
  assert.equal(canTransition("ai_active", "ai_active"), false);
});

test("canTransition rejects any transition out of the terminal closed state", () => {
  assert.equal(canTransition("closed", "ai_active"), false);
});

test("transition returns the target state when the transition is valid", () => {
  assert.equal(transition("handoff_pending", "human_active"), "human_active");
});

test("transition throws TransitionError with a descriptive message when invalid", () => {
  try {
    transition("closed", "ai_active");
    assert.fail("expected transition to throw");
  } catch (err) {
    assert.ok(err instanceof TransitionError);
    assert.equal((err as Error).message, "Invalid transition: closed → ai_active");
  }
});

test("aiShouldRespond is true only for ai_active", () => {
  assert.equal(aiShouldRespond("ai_active"), true);
  const others: ConversationState[] = [
    "human_active",
    "handoff_pending",
    "waiting_reply",
    "paused",
    "closed",
  ];
  for (const state of others) {
    assert.equal(aiShouldRespond(state), false);
  }
});

test("detectsHandoffTrigger matches a known phrase regardless of case", () => {
  assert.equal(detectsHandoffTrigger("QUIERO HABLAR con alguien"), true);
});

test("detectsHandoffTrigger matches a phrase with accents normalized away", () => {
  assert.equal(detectsHandoffTrigger("AGÉNTE, necesito ayuda"), true);
});

test("detectsHandoffTrigger returns false when no trigger phrase is present", () => {
  assert.equal(detectsHandoffTrigger("¿cuál es el horario de atención?"), false);
});
