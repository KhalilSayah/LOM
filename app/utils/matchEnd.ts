/**
 * When a simulated match really ends.
 *
 * The engine nudges events that share a tick a second apart so the play-by-play keeps its
 * order, and in a busy ending (the Baron fight, the push, the nexus) that can carry the last
 * few events past `gameLength`. A clock that stops at `gameLength` then never shows the
 * nexus falling. Anything that plays a match to its end uses this instead.
 */
export function matchEnd(result: any): number {
  if (!result) return 0;
  const events = result.events ?? [];
  const last = events.length ? events[events.length - 1].t ?? 0 : 0;
  return Math.max(result.gameLength ?? 0, last);
}
