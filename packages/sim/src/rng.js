/**
 * One deterministic stream, consumed in a fixed order.
 *
 * docs/04 R1: same input, same seed, same sim_version, byte-identical event log. That
 * holds only while every draw comes from here and nothing in the engine reaches for
 * Math.random, Date.now or an iteration order that depends on object keys.
 *
 * The consequence is worth stating plainly, because it is easy to break by accident:
 * adding a draw anywhere shifts every draw after it, so a match that used to go one
 * way now goes another. That is a sim_version bump, not a bug fix. The golden tests
 * exist to make that impossible to do silently.
 */

/** FNV-1a over the seed string: a stable 32-bit integer, same on every platform. */
export function fnv1a(seed) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    // The FNV prime, as shifts, because `h * 16777619` loses precision past 2^53.
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }

  // Avalanche. FNV-1a alone leaves neighbouring strings — "fixture-41", "fixture-42"
  // — with hashes close enough that mulberry32 opens with similar numbers, and the
  // balance harness sees it as a side bias between identical squads. This is the
  // murmur3 finaliser, which is the standard answer and costs four operations.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * mulberry32: 32 bits of state, good enough for narrative, fast enough for 20k sims,
 * and short enough that anyone can check it does what it says.
 */
export function createRng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : fnv1a(String(seed));

  const float = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Warm-up. mulberry32's first outputs stay close for seeds that start close, and
  // real seeds are hash(fixture_id) over ids that increment — exactly the correlated
  // case. Left in, consecutive fixtures share early coin flips: the balance harness
  // caught it as a 45% win rate between identical squads, where 50% is the only
  // possible answer. Discarding a few draws decorrelates the stream; it costs
  // nothing and it is part of the version, so it may not be changed casually.
  for (let i = 0; i < 12; i++) float();

  return {
    float,
    /** Inclusive on both ends, which is what every call site here wants. */
    int: (min, max) => min + Math.floor(float() * (max - min + 1)),
    chance: (p) => float() < p,
    pick: (arr) => arr[Math.floor(float() * arr.length)],
    /**
     * One index from a weight array, proportional to the weights. Used wherever a
     * death or a map region has to land on somebody in particular.
     */
    weighted: (weights) => {
      const total = weights.reduce((n, w) => n + Math.max(0, w), 0);
      if (total <= 0) return 0;
      let roll = float() * total;
      for (let i = 0; i < weights.length; i++) {
        roll -= Math.max(0, weights[i]);
        if (roll <= 0) return i;
      }
      return weights.length - 1;
    },
  };
}
