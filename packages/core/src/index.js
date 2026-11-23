/**
 * @lom/core — the shared formulas.
 *
 * docs/10 calls this the centre of the whole design, and the reason is that these
 * functions are the contract between three things that must not drift apart: what a
 * card is worth in the collection, what it is worth in a match, and what the pipeline
 * had to measure to rate it in the first place.
 *
 * Pure functions, zero dependencies, no I/O. Plain ESM with JSDoc rather than
 * TypeScript, matching packages/card-engine, so `node` runs this directly in the
 * tuning harnesses and Vite consumes it in the app without a build step.
 *
 * Not here yet: `chemistryFor`, which lives in shared/roster.ts because the roster
 * screen grew it first and wraps it in the labels that screen shows. It belongs here
 * the day the server needs it too — which is the day lineups feed a real fixture.
 */

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/**
 * Mastery is the whole design in one curve (docs/02 section 2.4).
 *
 * A 92 OVR mid on a champion they have never played lands around 64 — a low-tier
 * card. A 78 OVR mid on a 95-mastery main lands around 77. That crossover is the
 * point: pool depth beats raw rating, so collecting breadth is collecting power.
 */
export function masteryFactor(mastery) {
  const m = clamp(Number(mastery) || 0, 0, 100);
  // Linear, as docs/02 section 2.4 specifies: 0.70 at zero mastery, 1.00 at 100.
  // It shipped for a while as `Math.pow(m / 100, 0.75)`, which softened the low end
  // (m=70 read 0.930 instead of 0.910) and quietly made raw OVR the thing that
  // mattered. Straight line restores the crossover the collection design rests on.
  return 0.7 + 0.3 * (m / 100);
}

/** Playing off-role costs you (docs/02). Exact match is free, anything else is not. */
export function roleFit(championRole, slot) {
  if (!championRole || championRole === slot) return 1;
  const adjacent = {
    TOP: ['JNG'],
    JNG: ['TOP', 'MID'],
    MID: ['JNG'],
    BOT: ['SUP'],
    SUP: ['BOT'],
  };
  // docs/02 section 2.4: flex 0.90, off-role 0.72. The adjacent-lane table above is
  // this codebase's stand-in for the spec's ">=10% pro presence in that role" flex
  // tier — see server/utils/championRoles.ts for why there is no third tier yet.
  return (adjacent[slot] || []).includes(championRole) ? 0.9 : 0.72;
}

/** docs/01 section 5: a level is worth 0.4 effective rating, capped at +3.6. */
export const levelBonus = (level = 1) => Math.min(3.6, 0.4 * (Math.max(1, Number(level) || 1) - 1));

/**
 * What a card is actually worth on a given champion, in a given slot.
 *
 * Clamped to 30..99 so a degenerate draft — a support forced onto a jungle champion
 * at zero mastery — produces a weak player rather than a negative one. The sim's fuzz
 * tests lean on that.
 */
/**
 * @param {{
 *   ovr: number,
 *   level?: number,
 *   mastery?: number,
 *   championRole?: string | null,
 *   slot?: string | null,
 * }} input
 * @returns {number}
 *
 * The types are spelled out because the defaults alone do not say them: `championRole = null`
 * makes TypeScript infer the parameter as `null`, so every caller passing an actual role was
 * a type error in a JS file nobody was checking.
 */
export function effRating({ ovr, level = 1, mastery = 0, championRole = null, slot = null }) {
  const base = (Number(ovr) || 0) + levelBonus(level);
  return clamp(base * masteryFactor(mastery) * roleFit(championRole, slot), 30, 99);
}

/**
 * Rarity is presentation derived from rating plus accolades (docs/02 section 3) — it
 * is never a power axis of its own, which is why nothing in the sim reads it.
 */
export function rarityForOvr(ovr, accolades = []) {
  const n = Number(ovr) || 0;
  const honours = new Set(accolades || []);
  const international = honours.has('WORLDS_WINNER') || honours.has('INTERNATIONAL_FINALIST');

  if (n >= 93 && honours.has('WORLDS_WINNER')) return 'ICON';
  if (n >= 90 || (n >= 87 && international)) return 'LEGENDARY';
  if (n >= 83 || (n >= 80 && honours.size > 0)) return 'EPIC';
  if (n >= 74) return 'RARE';
  return 'COMMON';
}

/**
 * A grade against expectation, not against output (docs/04 section 10).
 *
 * This is the emotional point of the box score: a 70 OVR support who was carried does
 * not get an S, and a 70 OVR support who held a game together does. Grading raw stats
 * would hand every S to whoever was already the best card, which nobody needs a
 * scoreboard to learn.
 */
export function gradeFor(delta, thresholds) {
  const t = thresholds || { splus: 1.75, s: 1.1, a: 0.45, b: -0.45, c: -1.1 };
  if (delta > t.splus) return 'S+';
  if (delta > t.s) return 'S';
  if (delta > t.a) return 'A';
  if (delta > t.b) return 'B';
  if (delta > t.c) return 'C';
  return 'D';
}

/** Standard score against a population, guarding the degenerate zero-spread case. */
export function zScore(value, values) {
  const n = values.length;
  if (!n) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  return sd < 1e-9 ? 0 : (value - mean) / sd;
}
