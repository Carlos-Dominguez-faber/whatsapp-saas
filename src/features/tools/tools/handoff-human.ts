import { z } from "zod";
import type { Tool } from "../core/tool";

const schema = z.object({
  reason: z.enum(["customer_request", "agent_stuck"]),
});

type HandoffArgs = z.infer<typeof schema>;

/**
 * Deriva la conversación a una persona del equipo.
 *
 * **No escribe en la base a propósito.** El guard de `buffer.ts` relee el
 * estado justo antes de enviar y descarta la respuesta si la conversación ya
 * no está en `ai_active`. Si esta herramienta aplicara el traspaso durante la
 * generación, la despedida que el agente acaba de escribir se descartaría: el
 * cliente pide un humano y recibe silencio. Acá solo se señala la intención;
 * el traspaso lo aplica `buffer.ts` después de despachar la respuesta, con el
 * guard intacto.
 */
export const handoffHumanTool: Tool<HandoffArgs> = {
  name: "handoff_human",
  // "write": no escribe acá, pero su efecto es cambiar el estado de la
  // conversación. Además "write" desactiva el retry de registry.runTool.
  sensitivity: "write",
  description:
    "Deriva la conversación a una persona del equipo. Úsala en dos casos y " +
    "solo en esos dos: reason='customer_request' cuando el cliente pide " +
    "explícitamente hablar con una persona; reason='agent_stuck' cuando YA " +
    "intentaste responder y la información necesaria no está disponible en el " +
    "contexto ni en ninguna herramienta. No la uses para cualquier pregunta " +
    "difícil, ni antes de intentar responder, ni cuando la respuesta está a la " +
    "vista. Llama primero a esta herramienta; recién después, cuando devuelva, " +
    "escribe como tu respuesta final del turno el mensaje de despedida " +
    "avisándole al cliente que lo va a atender una persona del equipo — esa " +
    "respuesta final no puede quedar vacía.",
  schema,
  // El gate real es tool_configs por workspace, como en todas las tools.
  enabledFor: () => true,
  run: async ({ reason }) => ({ ok: true, output: { handoff: true, reason } }),
};
