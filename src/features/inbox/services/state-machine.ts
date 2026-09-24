// F3-T1: State machine for conversation states.
// Pure functions only — no async, no DB imports.

export type ConversationState =
  | "ai_active"
  | "human_active"
  | "handoff_pending"
  | "waiting_reply"
  | "paused"
  | "closed";

// Valid transitions: from → allowed next states
const TRANSITIONS: Record<ConversationState, ConversationState[]> = {
  ai_active: [
    "human_active",
    "handoff_pending",
    "waiting_reply",
    "paused",
    "closed",
  ],
  handoff_pending: ["human_active", "ai_active", "closed"],
  human_active: ["ai_active", "waiting_reply", "paused", "closed"],
  waiting_reply: ["ai_active", "human_active", "closed"],
  paused: ["ai_active", "human_active", "closed"],
  closed: [], // terminal
};

export class TransitionError extends Error {
  constructor(from: ConversationState, to: ConversationState) {
    super(`Invalid transition: ${from} → ${to}`);
    this.name = "TransitionError";
  }
}

/**
 * Returns true when the transition from → to is defined in TRANSITIONS.
 */
export function canTransition(
  from: ConversationState,
  to: ConversationState,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Validates that from → to is a legal transition and returns the new state.
 * Throws TransitionError if the transition is not allowed.
 */
export function transition(
  from: ConversationState,
  to: ConversationState,
): ConversationState {
  if (!canTransition(from, to)) {
    throw new TransitionError(from, to);
  }
  return to;
}

/**
 * Returns true only when the AI should generate a reply.
 * Currently only ai_active state permits AI responses.
 */
export function aiShouldRespond(state: ConversationState): boolean {
  return state === "ai_active";
}

// Phrases that signal the user wants a human agent.
// Normalized to lowercase + NFD decomposition before matching.
//
// Toda frase de acá tiene que pedir una persona de forma inequívoca: el match
// es por substring y corre ANTES del LLM (decision-engine paso 3), así que un
// falso positivo deriva la conversación sin que el modelo ni la base de
// conocimiento alcancen a intervenir. Por eso "agente" a secas no está: derivaba
// a quien escribía "quiero un agente de WhatsApp para mi negocio", alguien
// preguntando por un producto, no pidiendo una persona.
// "agente humano" se queda, y "quiero hablar con un agente" sigue derivando
// por "hablar con".
const HANDOFF_PHRASES = [
  "hablar con",
  "hablar con alguien",
  "agente humano",
  "persona real",
  "quiero hablar",
  "necesito hablar",
  "con una persona",
  "con un humano",
  "atiende un humano",
  "operador",
  "soporte humano",
];

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "");
}

/**
 * Returns true when the message text contains a phrase that signals
 * the contact is requesting a human agent.
 * Accent-insensitive and case-insensitive.
 */
export function detectsHandoffTrigger(text: string): boolean {
  const normalized = normalizeText(text);
  return HANDOFF_PHRASES.some((phrase) =>
    normalized.includes(normalizeText(phrase)),
  );
}
