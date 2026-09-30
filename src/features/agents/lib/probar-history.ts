/**
 * What /probar sends back as history: the newest turns that fit the route's
 * limits (20 messages, 8,000 characters). Older turns drop off instead of the
 * chat failing once the conversation grows. Pure module, so it's testable.
 */

export interface ProbarMsg {
  role: "user" | "assistant";
  content: string;
}

export const PROBAR_MAX_MESSAGES = 20;
export const PROBAR_MAX_CHARS = 8_000;
export const PROBAR_MAX_MESSAGE_CHARS = 1_000;

export function probarHistory(messages: ProbarMsg[]): ProbarMsg[] {
  const kept: ProbarMsg[] = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0 && kept.length < PROBAR_MAX_MESSAGES; i--) {
    // An answer longer than a message may be (the route caps what it
    // receives, not what the agent writes) is cut to fit; an empty one is
    // dropped (the route refuses empty messages).
    const content = messages[i].content.trim().slice(0, PROBAR_MAX_MESSAGE_CHARS);
    if (!content) continue;
    if (chars + content.length > PROBAR_MAX_CHARS) break;
    chars += content.length;
    kept.unshift({ role: messages[i].role, content });
  }
  return kept;
}
