/**
 * Desenvuelve un resultado de Supabase (`{ data, error }`).
 *
 * Supabase NO rechaza la promesa ante un fallo de SQL, un timeout o una caída
 * de Postgres: resuelve `{ data: null, error: {…} }`. Leer solo `data` convierte
 * esa caída en un "no encontrado", que aguas arriba se traduce en responder 200
 * al webhook y perder el evento para siempre. Lanzar deja que la ruta responda
 * 500 y el proveedor reintente.
 *
 * Ojo: usar `.maybeSingle()`, no `.single()` — `single()` reporta "0 filas" como
 * error y acá eso sí se convertiría en una excepción indebida.
 */
export function unwrapResult<
  R extends { data: unknown; error: { message: string } | null },
>(result: R, what: string): R["data"] {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
}

/**
 * Reintenta un lookup hasta que devuelva algo.
 *
 * Existe por una carrera concreta: el `wamid` solo se conoce después de que
 * Kapso responde el POST, así que `dispatch` envía y recién entonces inserta la
 * fila. Un webhook de status puede ganarle a ese insert por una ida y vuelta a
 * Postgres, y sin reintento el status se descarta en silencio — con `failed`
 * eso significa perder el motivo del fallo, que es justo lo que el operador
 * necesita ver.
 *
 * `sleep` es inyectable para que los tests no esperen de verdad.
 */
export async function retryLookup<T>(
  lookup: () => Promise<T | null | undefined>,
  options: {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T | null> {
  const {
    attempts = 3,
    delayMs = 300,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  } = options;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const found = await lookup();
    if (found) return found;
    // Espera fija, no exponencial — la ventana que cubre es un insert
    // que ya está en vuelo, no un servicio caído.
    if (attempt < attempts - 1) await sleep(delayMs);
  }

  return null;
}
