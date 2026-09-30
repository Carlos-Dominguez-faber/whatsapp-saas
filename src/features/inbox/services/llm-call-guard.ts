import { NextResponse } from "next/server";
import { enforceCostPolicy } from "./cost-enforcer";
import {
  reserveClientTestChat,
  reserveWorkspaceLlmCall,
  type WorkspaceLlmCallType,
} from "./cost-tracker";

/** Calls per workspace and hour for each manager-facing LLM tool. */
export const WORKSPACE_LLM_CALL_LIMITS: Record<WorkspaceLlmCallType, number> = {
  template_generate: 20,
  agent_test_chat: 60,
};

const LIMIT_MESSAGE: Record<WorkspaceLlmCallType, string> = {
  template_generate: "Llegaste al límite de plantillas generadas con IA por hora. Intenta más tarde.",
  agent_test_chat: "Llegaste al límite de mensajes de prueba por hora. Intenta más tarde.",
};

type GuardOk = { ok: true; reservationId?: string };
type GuardFail = { ok: false; response: NextResponse };

const BUDGET_MESSAGE = {
  cut: "El workspace ya usó su presupuesto diario de IA. Intenta mañana.",
  degrade:
    "El workspace está por agotar su presupuesto diario de IA. Para que alcance para las conversaciones con clientes, generar plantillas y la prueba de agentes se pausan hasta mañana.",
} as const;

/**
 * Gate for a route that calls the model on the workspace's key outside an
 * agent turn: refuses once today's budget reaches the degrade threshold (what
 * is left is kept for customer conversations), then reserves one of the
 * workspace's hourly calls of `type`. The caller records the real tokens with
 * recordWorkspaceLlmCall(reservationId) once the model answers.
 */
export async function guardWorkspaceLlmCall(
  workspaceId: string,
  type: WorkspaceLlmCallType,
): Promise<GuardOk | GuardFail> {
  try {
    const budget = await enforceCostPolicy(workspaceId);
    if (budget.policy !== "allow") {
      return {
        ok: false,
        response: NextResponse.json(
          { error: BUDGET_MESSAGE[budget.policy] },
          { status: 429 },
        ),
      };
    }

    const reservation = await reserveWorkspaceLlmCall(
      workspaceId,
      type,
      WORKSPACE_LLM_CALL_LIMITS[type],
    );
    if (!reservation.allowed) {
      return {
        ok: false,
        response: NextResponse.json({ error: LIMIT_MESSAGE[type] }, { status: 429 }),
      };
    }
    return { ok: true, reservationId: reservation.reservationId };
  } catch (err) {
    console.error(`[llm-call-guard] ${type}:`, err);
    return {
      ok: false,
      response: NextResponse.json(
        { error: "No se pudo verificar el límite de uso de IA. Intenta de nuevo." },
        { status: 503 },
      ),
    };
  }
}

/**
 * /probar's hourly caps: per person (the account is often a client's) and per
 * workspace (every /probar account together). Its tokens also count toward
 * the daily budget.
 */
export const CLIENT_TEST_CHAT_LIMITS = { perUserHour: 20, perWorkspaceHour: 60 } as const;

const CLIENT_LIMIT_MESSAGE = {
  user_hour: "Llegaste al límite de mensajes de prueba por hora. Intenta más tarde.",
  workspace_hour: "Este espacio llegó al límite de mensajes de prueba por hora. Intenta más tarde.",
} as const;

const CLIENT_BUDGET_MESSAGE = "La prueba no está disponible por ahora. Intenta mañana.";

/**
 * Gate for /probar: the same budget rule as guardWorkspaceLlmCall (only while
 * today's budget is under the degrade threshold, so customer conversations
 * keep what is left), then one of the person's and the workspace's hourly
 * calls. Its messages don't name budgets: the person testing may not be on
 * the team.
 */
export async function guardClientTestChat(
  workspaceId: string,
  userId: string,
): Promise<GuardOk | GuardFail> {
  try {
    const budget = await enforceCostPolicy(workspaceId);
    if (budget.policy !== "allow") {
      return {
        ok: false,
        response: NextResponse.json({ error: CLIENT_BUDGET_MESSAGE }, { status: 429 }),
      };
    }

    const reservation = await reserveClientTestChat(workspaceId, userId, CLIENT_TEST_CHAT_LIMITS);
    if (!reservation.allowed) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: CLIENT_LIMIT_MESSAGE[reservation.reason ?? "workspace_hour"] },
          { status: 429 },
        ),
      };
    }
    return { ok: true, reservationId: reservation.reservationId };
  } catch (err) {
    console.error("[llm-call-guard] client_test_chat:", err);
    return {
      ok: false,
      response: NextResponse.json(
        { error: "No se pudo verificar el límite de uso. Intenta de nuevo." },
        { status: 503 },
      ),
    };
  }
}
