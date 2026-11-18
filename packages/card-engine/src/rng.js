/**
 * Deterministic RNG. Same card_key always produces the same artwork.
 * Mirrors the approach in @lom/sim so the whole project has one PRNG idiom.
 */

/** FNV-1a 32-bit. @param {string} str @returns {number} */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32. @param {number} seed @returns {() => number} */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A seeded generator bundle keyed by a card.
 * @param {string} key
 */
export function rngFor(key) {
  const next = mulberry32(hashString(key));
  return {
    float: next,
    /** @param {number} min @param {number} max */
    range: (min, max) => min + next() * (max - min),
    /** @param {number} min @param {number} max */
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    /** @template T @param {T[]} arr @returns {T} */
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}
