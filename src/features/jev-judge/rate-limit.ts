const WINDOW_MS = 60_000;
const LIMIT = 20;

interface Bucket {
  count: number;
  resetTime: number;
}

const buckets = new Map<string, Bucket>();

export function checkBenchRateLimit(
  workspaceId: string,
): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const record = buckets.get(workspaceId);
  if (!record || now > record.resetTime) {
    buckets.set(workspaceId, { count: 1, resetTime: now + WINDOW_MS });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (record.count >= LIMIT) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((record.resetTime - now) / 1000),
    };
  }
  record.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}
