import assert from "node:assert/strict";
import { test } from "node:test";
import {
  afterFailure,
  historyToSend,
  MAYBE_WROTE_NOTE,
  WROTE_NOTE,
} from "./playground-history.ts";

test("a failure after a write leaves a note the model reads; the error bubble stays local", () => {
  const added = afterFailure({
    errorText: "se ejecutó una acción",
    wroteSomething: true,
    connectionLost: false,
    isAdmin: true,
  });
  const history = historyToSend([{ role: "user", content: "agenda el martes" }, ...added]);
  assert.deepEqual(history, [
    { role: "user", content: "agenda el martes" },
    { role: "assistant", content: WROTE_NOTE },
  ]);
});

test("a dropped connection on an admin's turn may have written: the note says so", () => {
  const added = afterFailure({
    errorText: "Error de conexión",
    wroteSomething: false,
    connectionLost: true,
    isAdmin: true,
  });
  assert.deepEqual(historyToSend(added), [{ role: "assistant", content: MAYBE_WROTE_NOTE }]);
});

test("a manager's dropped connection, or a failure with no write, adds nothing to the history", () => {
  for (const opts of [
    { wroteSomething: false, connectionLost: true, isAdmin: false },
    { wroteSomething: false, connectionLost: false, isAdmin: true },
  ]) {
    const added = afterFailure({ errorText: "falló", ...opts });
    assert.deepEqual(historyToSend(added), []);
    assert.equal(added[0].error, true);
  }
});
