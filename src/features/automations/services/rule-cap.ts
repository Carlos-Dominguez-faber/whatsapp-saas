import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Tope de reglas ACTIVAS por workspace.
 *
 * No es un límite contractual: es protección de orden de magnitud entre
 * tenants. Se comprueba con lectura previa y NO con un constraint en SQL, así
 * que dos escrituras simultáneas pueden dejar 21 activas. Se acepta: cerrar esa
 * ventana costaría un lock por escritura sobre automation_rules.
 */
export const MAX_ACTIVE_RULES_PER_WORKSPACE = 20;

/**
 * Mensaje único del tope, en español natural: lo lee el operador, no un
 * desarrollador. Vive en la clase de error para que la API y las server actions
 * digan exactamente lo mismo.
 */
export class RuleCapError extends Error {
  constructor() {
    super(
      `Este espacio ya tiene ${MAX_ACTIVE_RULES_PER_WORKSPACE} automatizaciones ` +
        `activas. Desactiva una para activar otra.`,
    );
    this.name = "RuleCapError";
  }
}

/**
 * Comprueba el tope de reglas activas del workspace y lanza si se pasa.
 *
 * ÚNICA implementación del tope. La llaman los DOS escritores de
 * `automation_rules`: la ruta `api/workspace/[id]/automations` y las server
 * actions de `features/settings/services/automation-actions.ts`. Ponerlo solo
 * en la ruta dejaba un bypass determinista por la UI (R6-1).
 *
 * `opts.excludeRuleId` deja fuera del conteo la regla que se está por
 * reactivar o editar: sin eso, guardar la regla nº 20 ya activa se rechazaría
 * a sí misma.
 *
 * Lanza `RuleCapError` si el workspace ya está en el tope, y un `Error` común
 * si el conteo falla. La distinción importa: el primero es 422 / mensaje al
 * operador; el segundo es 500 / "no se pudo guardar". Fail-closed a propósito:
 * sin saber cuántas hay, dejar pasar la escritura sería fail-open.
 *
 * El caller pasa un cliente `service_role` (o de sesión con permiso de lectura
 * sobre `automation_rules`); esta función no decide autorización, eso ya se
 * resolvió antes de llamarla.
 */
export async function assertActiveRuleCap(
  db: SupabaseClient,
  workspaceId: string,
  opts?: { excludeRuleId?: string },
): Promise<void> {
  // Todo el conteo va en un único try/catch: un `db.from(...)` que LANZA (red
  // caída, cliente mal armado) es tan posible como uno que devuelve
  // `{ error }`, y los cuatro call sites confían en que este helper es el
  // único lugar que loguea el detalle técnico (ver su comentario "el detalle
  // ya se logueó en el helper"). Sin este catch, un throw se les escapaba sin
  // dejar rastro server-side.
  let count: number | null;
  try {
    let query = db
      .from("automation_rules")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("enabled", true);

    if (opts?.excludeRuleId) query = query.neq("id", opts.excludeRuleId);

    const result = await query;
    if (result.error) throw result.error;
    count = result.count;
  } catch (err) {
    console.error("[automations] failed to count active rules:", err);
    throw new Error("rule_cap_count_failed");
  }

  if ((count ?? 0) >= MAX_ACTIVE_RULES_PER_WORKSPACE) {
    throw new RuleCapError();
  }
}
