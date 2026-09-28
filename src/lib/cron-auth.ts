import { timingSafeEqual } from "node:crypto";

// Compartido por todas las rutas de src/app/api/cron/. Cualquier cron nuevo
// debe importar este helper, no copiarlo.

export function isAuthorized(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  // Fail closed: un secreto ausente jamás puede volverse `Bearer undefined`.
  if (!secret || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const provided = Buffer.from(header);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
