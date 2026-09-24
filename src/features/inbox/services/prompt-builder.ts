/**
 * prompt-builder.ts — canonical assembly of the agent system prompt.
 *
 * Both production (buffer.ts) and the in-UI playground (test-chat) MUST use this
 * so they never drift. Pure string assembly — no DB, no "use server".
 *
 * Order (guardrails go LAST — models obey end-of-prompt instructions most;
 * tool-honesty note goes after even that, so no workspace guardrail can
 * override it):
 *   now → summary → business info → knowledge base → response style →
 *   prompt base → WhatsApp format note → media capability note →
 *   strict rules/restrictions → tool-honesty note
 */

export type ResponseStyle = "concise" | "balanced" | "detailed";

export interface PromptGuardrails {
  /** Things the agent must always do. */
  rules?: string[];
  /** Things the agent must never do / say / mention. */
  restrictions?: string[];
}

export interface SystemPromptVars {
  agentName?: string | null;
  businessName?: string | null;
  contactName?: string | null;
}

export interface BuildSystemPromptParts {
  nowContext: string;
  bizContext: string;
  promptBase: string;
  summary?: string | null;
  kbContext?: string | null;
  responseStyle?: ResponseStyle | null;
  guardrails?: PromptGuardrails | null;
  vars?: SystemPromptVars;
}

// "balanced" is the natural default → no block, keeps the prompt lean.
const STYLE_INSTRUCTIONS: Record<ResponseStyle, string> = {
  concise:
    "Responde de forma breve y directa: ve al grano con el mínimo de palabras necesarias. Evita rodeos y relleno.",
  balanced: "",
  detailed:
    "Responde de forma completa y detallada: explica con el contexto necesario cuando ayude a la persona.",
};

const WHATSAPP_FORMAT_NOTE =
  "## Formato\n" +
  'Escribes para WhatsApp. Usa *negrita* (un solo asterisco), _cursiva_ y listas con "- ". ' +
  "NO uses Markdown: nada de **, ##, encabezados, ni tablas.";

// Voice notes are auto-transcribed and images auto-described before they reach
// the agent, so the text it reads already contains their content. Without this
// the model falls back to the generic "no puedo escuchar audios" chatbot
// disclaimer when a customer's (transcribed) message asks about voice/audio.
const MEDIA_CAPABILITY_NOTE =
  "## Notas de voz e imágenes\n" +
  "Las notas de voz del cliente se transcriben automáticamente a texto y las " +
  "imágenes se describen automáticamente: lo que lees ya incluye su contenido. " +
  "Respóndelo con normalidad. NUNCA digas que no puedes escuchar audios/notas " +
  "de voz ni ver imágenes — sí puedes, ya te llegan convertidos a texto.";

// This must be the LAST thing appended in buildSystemPrompt, after
// guardrailsBlock — a misconfigured workspace guardrail (e.g. "siempre
// ofrece enviar confirmación por correo") must never be able to override
// this safety/trust rule.
const TOOL_HONESTY_NOTE =
  "## Honestidad sobre tus capacidades\n" +
  "Solo puedes realizar las acciones para las que tienes una herramienta " +
  "disponible ahora mismo. NUNCA prometas una acción — enviar un correo, un " +
  "SMS, notificar a alguien, generar un documento, etc. — a menos que " +
  "corresponda exactamente a una herramienta que acabas de invocar con " +
  "éxito. Si el cliente pide algo que ninguna de tus herramientas cubre, " +
  "dile con claridad que no puedes hacerlo tú directamente y sugiérele " +
  "contactar al negocio para esa solicitud.\n" +
  "Esto es REACTIVO: aplica solo cuando el cliente ya pidió algo concreto. " +
  "NUNCA anuncies, enumeres ni aclares tus limitaciones por tu cuenta, y " +
  "menos al saludar: un “Hola” se responde saludando y preguntando en qué " +
  "puedes ayudar, sin listar lo que puedes o no puedes hacer.";

export function substituteVars(text: string, vars?: SystemPromptVars): string {
  if (!vars) return text;
  return text
    .replaceAll("{{agent_name}}", vars.agentName ?? "")
    .replaceAll("{{business_name}}", vars.businessName ?? "")
    .replaceAll("{{contact.name}}", vars.contactName ?? "");
}

function buildGuardrailsBlock(g: PromptGuardrails | null | undefined): string {
  if (!g) return "";
  const rules = (g.rules ?? []).map((s) => s.trim()).filter(Boolean);
  const restrictions = (g.restrictions ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  if (rules.length === 0 && restrictions.length === 0) return "";

  const lines = ["=== REGLAS ESTRICTAS (cumple SIEMPRE) ==="];
  if (rules.length > 0) {
    lines.push("Siempre debes:");
    lines.push(...rules.map((r) => `- ${r}`));
  }
  if (restrictions.length > 0) {
    if (rules.length > 0) lines.push("");
    lines.push("NUNCA debes (bajo ninguna circunstancia):");
    lines.push(...restrictions.map((r) => `- ${r}`));
  }
  return lines.join("\n");
}

export function buildSystemPrompt(parts: BuildSystemPromptParts): string {
  const summaryBlock =
    parts.summary && parts.summary.trim()
      ? `## Resumen de la conversación\n${parts.summary.trim()}`
      : "";

  const styleText = parts.responseStyle
    ? STYLE_INSTRUCTIONS[parts.responseStyle]
    : "";
  const styleBlock = styleText ? `## Estilo de respuesta\n${styleText}` : "";

  const base = substituteVars(parts.promptBase, parts.vars);
  const guardrailsBlock = buildGuardrailsBlock(parts.guardrails);

  return [
    parts.nowContext,
    summaryBlock,
    parts.bizContext,
    parts.kbContext ?? "",
    styleBlock,
    base,
    WHATSAPP_FORMAT_NOTE,
    MEDIA_CAPABILITY_NOTE,
    guardrailsBlock,
    TOOL_HONESTY_NOTE,
  ]
    .filter(Boolean)
    .join("\n\n");
}
