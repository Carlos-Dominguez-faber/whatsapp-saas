import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Zona horaria del workspace, leída de `integrations.config.timezone`.
 *
 * Vive acá y no dentro de un servicio porque la leen varios frentes, y dos
 * lectores distintos de la misma columna se desincronizan: un dato que se
 * decide en la zona del negocio pero se muestra en UTC dice una hora que no es.
 */

/**
 * Orden de desempate, de mayor a menor prioridad. `highlevel` primero porque es
 * el proveedor con el que se agenda; Cal.com queda de respaldo para el
 * workspace que solo lo tenga a él.
 *
 * **El desempate es fijo, no es "la primera fila que vuelva".** Un workspace
 * con las dos integraciones en zonas distintas tiene que resolver siempre a la
 * misma, o el que depure un resultado corrido no puede predecirlo.
 */
const TIMEZONE_PROVIDER_ORDER = ["highlevel", "caldotcom"] as const;

/** Default cuando no hay zona configurada, o cuando la que hay no sirve. */
export const DEFAULT_TIMEZONE = "UTC";

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `true` si `Intl` sabe resolver la zona. Una zona inválida —`"Santiago"` en
 * vez de `"America/Santiago"`, por ejemplo— hace que `Intl.DateTimeFormat`
 * lance un `RangeError`, y ese throw pasado al caller se come el trabajo de
 * todo el tenant en silencio.
 */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Zona horaria del workspace. Tres situaciones distintas:
 *
 * - `timezone` ausente, `null` o cadena vacía, **con la lectura OK** →
 *   `"UTC"`. Es el default documentado, no un error.
 * - `timezone` presente pero **inválida** (`"Santiago"`, con espacios,
 *   cualquier cosa que haga lanzar a `Intl`) → esa fila **se ignora**, con
 *   `console.error`, y se sigue con el proveedor siguiente. Si **ninguna** de
 *   las escritas es válida → **`null`**.
 * - **Fallo de lectura** de `integrations` → **`null`**, con `console.error`.
 *   Si no pudimos leer la fila no sabemos si el workspace tiene zona
 *   configurada, así que asumir UTC es el mismo daño por la puerta de atrás.
 *
 * `null` significa, textual, "no sé la zona con certeza". Por eso **`?? "UTC"`
 * en un callsite está PROHIBIDO**: ese fallback reabre las tres puertas de un
 * saque. El caller decide qué hacer con `null`, nunca convertirlo en un string.
 *
 * **Nunca lanza.** La señal es el valor de retorno (`null`), no un fallback
 * silencioso.
 */
export async function resolveWorkspaceTimezone(
  db: SupabaseClient,
  workspaceId: string,
): Promise<string | null> {
  let rows: Array<{ provider: string; config: unknown }>;
  try {
    const { data, error } = await db
      .from("integrations")
      .select("provider, config")
      .eq("workspace_id", workspaceId)
      .in("provider", TIMEZONE_PROVIDER_ORDER);
    if (error) throw new Error(error.message);
    rows = (data ?? []) as Array<{ provider: string; config: unknown }>;
  } catch (err) {
    console.error(
      `[workspace-timezone] workspace ${workspaceId}: no pude leer integrations, no hay zona horaria confiable:`,
      msg(err),
    );
    return null;
  }

  // El desempate se resuelve acá, en JS, y NO con un `.limit(1)` sin `order`,
  // que tendría un ganador indeterminado.
  // Una zona **válida** es un dato positivo, no una segunda adivinanza: el
  // negocio tiene una sola zona horaria, así que si un proveedor la tiene mal
  // escrita y el otro bien, la bien escrita ES la del negocio. Por eso una
  // fila inválida se descarta y se sigue con la siguiente, en vez de cortar.
  let algunaEscrita = false;
  for (const provider of TIMEZONE_PROVIDER_ORDER) {
    const row = rows.find((r) => r.provider === provider);
    const tz = (row?.config as { timezone?: unknown } | null)?.timezone;
    if (typeof tz !== "string" || tz.length === 0) continue;
    algunaEscrita = true;
    if (!isValidTimeZone(tz)) {
      // Config rota igual: el `console.error` va aunque el respaldo salve el
      // resultado, o el typo no se arregla nunca.
      console.error(
        `[workspace-timezone] workspace ${workspaceId}: '${provider}' tiene una zona horaria inválida (${tz}); se ignora esa fila`,
      );
      continue;
    }
    return tz;
  }

  // Alguna zona estaba escrita y ninguna resultó legible: ahí sí no tenemos
  // ningún dato, y `null` significa no confiar. Sin ninguna escrita, en cambio,
  // `"UTC"` es el default documentado.
  if (algunaEscrita) {
    console.error(
      `[workspace-timezone] workspace ${workspaceId}: ninguna zona horaria configurada es válida; no hay zona confiable`,
    );
    return null;
  }
  return DEFAULT_TIMEZONE;
}
