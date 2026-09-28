/**
 * The playground's conversation: what the panel shows and what it sends back
 * as history. Pure module (no React), so it's testable.
 */

export interface PlaygroundMsg {
  role: "user" | "assistant";
  content: string;
  /** An error shown in the panel, never sent back as part of the history. */
  error?: boolean;
  /** A note for the model about the previous turn, sent as history. */
  note?: boolean;
}

/** Tells the model a write ran before the failure, so it isn't repeated. */
export const WROTE_NOTE =
  "[Sistema: en el turno anterior se ejecutó una acción antes del error; no la repitas]";

/** The same when the connection dropped: an admin's turn may have written. */
export const MAYBE_WROTE_NOTE =
  "[Sistema: el turno anterior pudo haber ejecutado una acción antes de perderse la conexión; no la repitas sin confirmarlo]";

/** The history the server gets: every turn but the error bubbles. */
export function historyToSend(
  messages: PlaygroundMsg[],
): Array<{ role: "user" | "assistant"; content: string }> {
  return messages.filter((m) => !m.error).map(({ role, content }) => ({ role, content }));
}

/**
 * The turns a failed request adds: the error, for the panel, and — when a
 * write ran (the server said so) or may have (the connection dropped on an
 * admin, whose test runs write tools) — a note that the model does read, so
 * a later "¿quedó?" doesn't make it run the write again.
 */
export function afterFailure(opts: {
  errorText: string;
  wroteSomething: boolean;
  connectionLost: boolean;
  isAdmin: boolean;
}): PlaygroundMsg[] {
  const out: PlaygroundMsg[] = [
    { role: "assistant", content: `⚠️ ${opts.errorText}`, error: true },
  ];
  if (opts.wroteSomething) {
    out.push({ role: "assistant", content: WROTE_NOTE, note: true });
  } else if (opts.connectionLost && opts.isAdmin) {
    out.push({ role: "assistant", content: MAYBE_WROTE_NOTE, note: true });
  }
  return out;
}
