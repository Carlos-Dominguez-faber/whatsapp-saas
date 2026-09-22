/** Published TypeSafe price for jev input tokens, checked 18 Sep 2026. Output is not billed. */
export const JEV_INPUT_USD_PER_MILLION = 0.042;

export function estimateCostUsd(inputTokens: number): number {
  return (inputTokens * JEV_INPUT_USD_PER_MILLION) / 1_000_000;
}

/** America/Mexico_City has been UTC−6 year-round since 2022. */
export function mexicoDayStartIso(now = new Date()): string {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return new Date(`${day}T00:00:00-06:00`).toISOString();
}
