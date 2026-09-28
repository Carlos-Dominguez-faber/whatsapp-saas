import assert from "node:assert/strict";
import { test } from "node:test";
import { isHandoffTransition, shouldNotifyHandoff } from "./handoff-alert.ts";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import type { ConversationRow } from "@/features/inbox/types";

/**
 * `isHandoffTransition` decide si un evento de `postgres_changes` merece un
 * aviso al operador. Tiene que ser una transición real: un UPDATE que entra a
 * `handoff_pending` viniendo de otro estado. Todo lo demás — ya estaba ahí,
 * pasó a otro estado, o nació así (INSERT) — no avisa, porque de lo contrario
 * cada UPDATE de una fila ya en espera dispararía otra notificación.
 */

function updatePayload(
  oldState: string,
  newState: string,
): RealtimePostgresChangesPayload<ConversationRow> {
  return {
    schema: "public",
    table: "conversations",
    commit_timestamp: "2026-09-12T00:00:00Z",
    errors: [],
    eventType: "UPDATE",
    new: { id: "c1", state: newState } as ConversationRow,
    old: { id: "c1", state: oldState } as Partial<ConversationRow>,
  } as RealtimePostgresChangesPayload<ConversationRow>;
}

test("isHandoffTransition avisa cuando la conversación RECIÉN entra a handoff_pending", () => {
  assert.equal(isHandoffTransition(updatePayload("ai_active", "handoff_pending")), true);
});

test("isHandoffTransition no avisa si ya estaba en handoff_pending", () => {
  assert.equal(
    isHandoffTransition(updatePayload("handoff_pending", "handoff_pending")),
    false,
  );
});

test("isHandoffTransition no avisa si pasó a otro estado", () => {
  assert.equal(
    isHandoffTransition(updatePayload("handoff_pending", "human_active")),
    false,
  );
});

test("isHandoffTransition no avisa en un INSERT, aunque nazca en handoff_pending", () => {
  const payload = {
    schema: "public",
    table: "conversations",
    commit_timestamp: "2026-09-12T00:00:00Z",
    errors: [],
    eventType: "INSERT",
    new: { id: "c1", state: "handoff_pending" } as ConversationRow,
    old: {},
  } as RealtimePostgresChangesPayload<ConversationRow>;
  assert.equal(isHandoffTransition(payload), false);
});

function updateWithoutOld(newState: string): RealtimePostgresChangesPayload<ConversationRow> {
  return {
    schema: "public",
    table: "conversations",
    commit_timestamp: "2026-09-12T00:00:00Z",
    errors: [],
    eventType: "UPDATE",
    new: { id: "c1", state: newState } as ConversationRow,
    // Con RLS, Realtime puede mandar solo la llave primaria.
    old: { id: "c1" } as Partial<ConversationRow>,
  } as RealtimePostgresChangesPayload<ConversationRow>;
}

test("shouldNotifyHandoff avisa una sola vez por espera aunque old no traiga el estado", () => {
  const notified = new Set<string>();
  assert.equal(shouldNotifyHandoff(updateWithoutOld("handoff_pending"), notified), true);
  // Otro UPDATE de la misma conversación en espera (mensaje nuevo): no repite.
  assert.equal(shouldNotifyHandoff(updateWithoutOld("handoff_pending"), notified), false);
  // Vuelve a la IA y más tarde entra otra vez: sí avisa de nuevo.
  assert.equal(shouldNotifyHandoff(updateWithoutOld("ai_active"), notified), false);
  assert.equal(shouldNotifyHandoff(updateWithoutOld("handoff_pending"), notified), true);
});

test("shouldNotifyHandoff no avisa por una conversación que ya esperaba al cargar el inbox", () => {
  const notified = new Set<string>(["c1"]);
  assert.equal(shouldNotifyHandoff(updateWithoutOld("handoff_pending"), notified), false);
});
