/**
 * Champion static data: archetype, and the tags the composition modifier reads.
 *
 * docs/04 section 2 injects this once via `configureChampionData()` so the engine
 * holds no asset dependency — it must simulate a match for a champion it has never
 * heard of, which is exactly what happens the first time the catalogue is rebuilt
 * from a newer patch.
 *
 * The fallback is therefore load-bearing rather than defensive: an unknown champion
 * takes the archetype its slot usually plays and a neutral set of tags, so the game
 * is a little blander but never wrong, and never throws.
 */

const DEFAULT_BY_SLOT = {
  TOP: 'TANK',
  JNG: 'SKIRMISHER',
  MID: 'ASSASSIN',
  BOT: 'SCALING_CARRY',
  SUP: 'UTILITY',
};

const NEUTRAL_TAGS = {
  frontline: false,
  engage: false,
  peel: false,
  aoe: false,
  damage: 'MIXED',
};

/** @type {Map<string, {archetype: string, tags: object}>} */
let TABLE = new Map();

/**
 * Install the champion table. Keys are champion names as the catalogue stores them;
 * lookups are case-insensitive because a data pipeline and a human will disagree
 * about "Kai'Sa" sooner or later.
 */
export function configureChampionData(table) {
  TABLE = new Map();
  for (const [name, entry] of Object.entries(table || {})) {
    TABLE.set(String(name).toLowerCase(), {
      archetype: entry.archetype || null,
      tags: { ...NEUTRAL_TAGS, ...(entry.tags || {}) },
    });
  }
}

export function championEntry(champion, slot) {
  const found = TABLE.get(String(champion || '').toLowerCase());
  return {
    archetype: found?.archetype || DEFAULT_BY_SLOT[slot] || 'UTILITY',
    tags: found?.tags || NEUTRAL_TAGS,
  };
}

export const classOf = (champion, slot) => championEntry(champion, slot).archetype;

/**
 * The composition modifier (docs/04 section 5.3), 0.92 to 1.08.
 *
 * Returned with its factors named, because the draft screen shows them as they
 * update and that transparency is what turns drafting from guessing into reasoning.
 * The engine only needs the number; the names cost nothing and are the difference
 * between "your comp is 1.03" and "two frontline, hard engage, no peel".
 */
export function compositionFor(players, { min, max }) {
  // With no champion table installed every tag reads false, and scoring that would
  // hand both sides the worst possible comp — "no engage, no peel, one damage type"
  // is a judgement about data we do not have, not about the draft.
  const known = players.filter((p) => TABLE.has(String(p.champion || '').toLowerCase()));
  if (known.length < players.length) {
    return { modifier: 1, factors: [{ name: 'No champion data', value: 0 }] };
  }

  const tags = players.map((p) => championEntry(p.champion, p.slot).tags);
  const factors = [];

  // Frontline balance. Two front, three back is the shape that plays; five of either
  // is a comp that either cannot get in or cannot survive being got into.
  const frontline = tags.filter((t) => t.frontline).length;
  const frontDelta = frontline === 2 ? 0.03 : frontline === 1 || frontline === 3 ? 0.01 : -0.03;
  factors.push({ name: frontline === 2 ? 'Balanced frontline' : `${frontline} frontline`, value: frontDelta });

  const engage = tags.some((t) => t.engage);
  factors.push({ name: engage ? 'Hard engage' : 'No engage tool', value: engage ? 0.02 : -0.02 });

  const peel = tags.some((t) => t.peel);
  factors.push({ name: peel ? 'Peel for the carry' : 'No disengage', value: peel ? 0.015 : -0.015 });

  // AoE concentration helps a teamfight and hurts a skirmish. Scored for the fight,
  // since that is what decides games.
  const aoe = tags.filter((t) => t.aoe).length;
  const aoeDelta = aoe >= 2 ? 0.02 : aoe === 1 ? 0.005 : -0.01;
  factors.push({ name: aoe >= 2 ? 'AoE teamfight' : 'Single-target damage', value: aoeDelta });

  const ad = tags.filter((t) => t.damage === 'AD').length;
  const ap = tags.filter((t) => t.damage === 'AP').length;
  const split = ad === 0 || ap === 0 ? -0.015 : 0.015;
  factors.push({ name: split > 0 ? 'Mixed damage' : 'One damage type', value: split });

  const raw = 1 + factors.reduce((n, f) => n + f.value, 0);
  return { modifier: Math.min(max, Math.max(min, raw)), factors };
}
