import type { H3Event } from 'h3';

/**
 * A small sliding-window rate limit, kept in memory.
 *
 * Deliberately simple: one Map per server instance. On Vercel that means a limit per warm
 * lambda rather than per deployment, which is weaker than a shared store but stops the
 * cheap abuse it is here for — a script hammering sign-up or guessing invite codes from one
 * address — without adding a dependency or a table. Anything that needs a hard guarantee
 * belongs in Postgres, not here.
 */

const buckets = new Map<string, number[]>();
let lastSweep = 0;

function sweep(now: number, windowMs: number) {
  if (now - lastSweep < 60_000 && buckets.size < 5000) return;
  lastSweep = now;
  for (const [key, hits] of buckets) {
    const live = hits.filter((t) => now - t < windowMs);
    if (live.length) buckets.set(key, live);
    else buckets.delete(key);
  }
}

/**
 * Counts one hit against `key`. Returns true when it is allowed, false when the key has
 * already used `limit` hits inside the last `windowMs`.
 */
export function allowHit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  sweep(now, Math.max(windowMs, 3_600_000));
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}

/** The caller's address, as far as the platform's proxy tells us. */
export function clientAddress(event: H3Event): string {
  return getRequestIP(event, { xForwardedFor: true }) || 'unknown';
}

/** Throws a 429 written for a person, not for a log. */
export function tooMany(message = 'Too many tries in a short time. Wait a few minutes and try again.'): never {
  throw createError({ statusCode: 429, statusMessage: message });
}
