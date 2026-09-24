/**
 * Helpers de la tool de disponibilidad (check_availability, HighLevel).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Un ISO solo es interpretable sin adivinar si trae offset explícito. */
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

export interface GroupedSlots {
  /** `{ "YYYY-MM-DD": ["<ISO original del proveedor>", ...] }` */
  days: Record<string, string[]>;
  /** Días completos del rango que quedaron fuera por `maxDays`. */
  omittedDays: number;
  /** Valores que no se pudieron interpretar. NUNCA se descartan en silencio. */
  unreadable: number;
}

/**
 * Agrupa slots por día LOCAL en `tz`, conservando **el ISO original del
 * proveedor** como valor.
 *
 * Reemplaza el recorte ciego a los primeros 20 slots: cortaba el rango a mitad
 * de camino y el bot negaba horarios que sí existían. Un recorte por muestra
 * (uno de cada N) tampoco sirve: deja huecos sueltos DENTRO de un día, y el
 * bot termina diciendo que no hay cupo a las 12:00 cuando sí lo hay.
 * Acá el invariante es al revés: un día que aparece en el resultado aparece
 * SIEMPRE completo; si el rango excede `maxDays` se descartan DÍAS ENTEROS
 * (los últimos), nunca horarios sueltos dentro de un día presente.
 *
 * El valor es el ISO y no una etiqueta `"HH:MM"` por tres razones:
 *  1. `"HH:MM"` colapsa los dos cupos distintos que el retroceso de horario
 *    deja a la misma hora local — rompía el invariante de "día completo".
 *  2. Pierde los segundos, con el mismo efecto.
 *  3. El modelo agenda copiando un `datetime_iso`; con la etiqueta tenía que
 *    reconstruirlo haciendo aritmética de fechas, que es lo que peor hace.
 */
export function groupByDay(
  slots: readonly unknown[],
  tz: string,
  maxDays = 14,
): GroupedSlots {
  // day -> (ISO original -> instante), para ordenar por instante y deduplicar.
  const byDay = new Map<string, Map<string, number>>();
  let unreadable = 0;

  for (const raw of slots) {
    const iso = toIso(raw);
    const instant = iso === null ? NaN : Date.parse(iso);
    if (iso === null || Number.isNaN(instant)) {
      unreadable++;
      continue;
    }
    const day = localDay(instant, tz);
    if (!byDay.has(day)) byDay.set(day, new Map());
    byDay.get(day)!.set(iso, instant);
  }

  const sortedDays = [...byDay.keys()].sort();
  const keptDays = sortedDays.slice(0, maxDays);
  const days: Record<string, string[]> = {};
  for (const day of keptDays) {
    days[day] = [...byDay.get(day)!.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([iso]) => iso);
  }
  return { days, omittedDays: sortedDays.length - keptDays.length, unreadable };
}

/**
 * ISO de un slot tal como lo devolvió el proveedor (HighLevel manda strings).
 *
 * Un timestamp sin offset (`"2026-09-14T12:00:00"`) se rechaza a propósito:
 * `Date.parse` lo interpretaría en la zona del SERVIDOR, así que el día local
 * dependería de dónde corre el proceso. Ilegible y declarado es mejor que
 * adivinado.
 */
function toIso(value: unknown): string | null {
  if (typeof value !== "string" || !HAS_OFFSET.test(value)) return null;
  return value;
}

/** Día `YYYY-MM-DD` de `instant` en `tz`. Degrada a UTC si la zona no sirve. */
function localDay(instant: number, tz: string): string {
  let local: string;
  try {
    local = new Date(instant).toLocaleString("sv-SE", { timeZone: tz });
  } catch {
    local = new Date(instant).toLocaleString("sv-SE", { timeZone: "UTC" });
  }
  return local.split(" ")[0];
}

/**
 * Primera candidata que sea una zona IANA válida, o `"UTC"`.
 *
 * La zona la puede pedir el LLM como texto libre: `"America/Santiagoo"`,
 * `"Chile"` o `"GMT-3"` hacen lanzar a `Intl`. Antes se degradaba a UTC en
 * silencio y el output igual etiquetaba la zona pedida, así que el bot ofrecía
 * "12:00" que en Santiago eran las 09:00.
 */
export function resolveTimeZone(
  ...candidates: (string | undefined | null)[]
): string {
  for (const tz of candidates) {
    if (!tz) continue;
    try {
      new Intl.DateTimeFormat("sv-SE", { timeZone: tz });
      return tz;
    } catch {
      // siguiente candidata
    }
  }
  return "UTC";
}

export interface AvailabilityOutput {
  days: Record<string, string[]>;
  count: number;
  timezone: string;
  covered_until: string | null;
  omitted_days: number;
  unreadable: number;
  message: string;
}

/**
 * Output de la tool de disponibilidad.
 *
 * Regla dura: **un dato ilegible nunca se convierte en "no hay horarios"**.
 * Si hubo descartes, el mensaje no puede afirmar ausencia de cupos — esa es la
 * misma clase de mentira que este cambio vino a arreglar, pero total.
 *
 * `requestedTz` es la zona que pidió el LLM (si pidió alguna); si no coincide
 * con la que se usó de verdad, el output lo dice.
 */
export function buildAvailabilityOutput(
  grouped: GroupedSlots,
  timezone: string,
  requestedTz?: string,
): AvailabilityOutput {
  const dayKeys = Object.keys(grouped.days);
  const count = Object.values(grouped.days).reduce(
    (n, isos) => n + isos.length,
    0,
  );
  const coveredUntil = dayKeys.length ? dayKeys[dayKeys.length - 1] : null;

  const parts: string[] = [];
  if (count > 0) {
    parts.push(
      `Hay ${count} horarios disponibles. Cada uno es el instante exacto en ISO: cópialo tal cual para agendar.`,
    );
  } else if (grouped.unreadable > 0) {
    parts.push(
      `No se pudo leer ningún horario del calendario, así que no se puede afirmar que no haya disponibilidad en ese rango.`,
    );
  } else {
    parts.push("No hay horarios disponibles en ese rango.");
  }

  if (count > 0 && grouped.unreadable > 0) {
    parts.push(
      `Además hay ${grouped.unreadable} horarios que el calendario devolvió en un formato ilegible y no están en esta lista.`,
    );
  } else if (count === 0 && grouped.unreadable > 0) {
    parts.push(`Se descartaron ${grouped.unreadable} valores ilegibles.`);
  }

  if (grouped.omittedDays > 0 && coveredUntil) {
    parts.push(
      `Esta lista solo cubre hasta el ${coveredUntil}; hay ${grouped.omittedDays} días más con horarios que no entran acá.`,
    );
  }

  if (requestedTz && requestedTz !== timezone) {
    parts.push(
      `La zona horaria pedida ("${requestedTz}") no es válida; los horarios están en ${timezone}.`,
    );
  }

  return {
    days: grouped.days,
    count,
    timezone,
    covered_until: coveredUntil,
    omitted_days: grouped.omittedDays,
    unreadable: grouped.unreadable,
    message: parts.join(" "),
  };
}

/**
 * Offset de `tz` respecto de UTC en ese instante, en ms. Devuelve 0 si la zona
 * no es válida (viene del LLM), lo que deja el comportamiento anterior: UTC.
 */
function offsetMs(instant: number, tz: string): number {
  try {
    // "sv-SE" formatea como "2026-06-12 00:00:00", casi ISO.
    const local = new Date(instant).toLocaleString("sv-SE", { timeZone: tz });
    const parsed = Date.parse(`${local.replace(" ", "T")}Z`);
    return Number.isNaN(parsed) ? 0 : parsed - instant;
  } catch {
    return 0;
  }
}

/**
 * Rango [inicio del día `from`, fin del día `to`] en epoch ms, interpretado en
 * `tz`. Devuelve `null` si alguna fecha es inválida.
 *
 * `Date.parse("2026-06-12")` es medianoche **UTC**: en hora chilena (UTC-3) eso
 * corría la ventana real a "21:00 del día anterior – 20:59 del día pedido", y
 * se rompe con un calendario que atienda después de las 21:00.
 */
export function zonedDayRange(
  from: string,
  to: string,
  tz: string,
): { startMs: number; endMs: number } | null {
  const startMs = zonedMidnight(from, tz);
  // El fin del rango es la medianoche del día SIGUIENTE menos 1 ms, no
  // `+ 24 h`: en el cambio de hora el día local dura 23 o 25 horas. Con las 24
  // fijas, el 4 de abril en Chile (25 h) perdía su última hora y la tool negaba
  // un cupo que existía — el mismo bug que originó todo esto.
  const nextMidnight = zonedMidnight(nextDay(to), tz);
  if (startMs === null || nextMidnight === null) return null;
  return { startMs, endMs: Math.max(nextMidnight - 1, startMs) };
}

/** Día calendario siguiente a `date` (`YYYY-MM-DD`), en aritmética UTC. */
function nextDay(date: string): string {
  const utcMidnight = Date.parse(date.slice(0, 10));
  if (Number.isNaN(utcMidnight)) return date;
  return new Date(utcMidnight + DAY_MS).toISOString().slice(0, 10);
}

/** Fecha calendario (`YYYY-MM-DD`) del instante `ms` en `tz`. */
function localDate(ms: number, tz: string): string {
  try {
    return new Date(ms).toLocaleDateString("en-CA", { timeZone: tz });
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

function zonedMidnight(date: string, tz: string): number | null {
  // Solo la parte de fecha: si el LLM manda "2026-06-12T14:00:00Z" igual
  // queremos el día completo.
  const day = date.slice(0, 10);
  const utcMidnight = Date.parse(day);
  if (Number.isNaN(utcMidnight)) return null;
  // Dos pasadas. La primera mide el offset en la medianoche UTC, que puede caer
  // todavía en el régimen horario ANTERIOR; la segunda lo remide en el instante
  // candidato, que ya cae en el régimen correcto. Sin ella, la medianoche del
  // 5 de abril en Chile se calculaba en UTC-3 en vez de UTC-4 y la ventana
  // entera quedaba corrida una hora.
  const candidate = utcMidnight - offsetMs(utcMidnight, tz);
  const result = utcMidnight - offsetMs(candidate, tz);
  // Salto de primavera: la medianoche local NO existe (el 2026-09-06 en Chile
  // el reloj salta de 00:00 a 01:00). La segunda pasada devuelve entonces un
  // instante que cae en las 23:00 del día ANTERIOR, y el día entero arranca una
  // hora antes de lo que debe. Se detecta comparando la fecha local del
  // resultado con la pedida; el primer instante que sí existe es `candidate`.
  // En el salto de otoño (medianoche dos veces) `result` ya es la primera de
  // las dos, que es la correcta, y esta rama no se toma.
  return localDate(result, tz) === day ? result : candidate;
}
