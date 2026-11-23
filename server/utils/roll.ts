/**
 * The pack roll — docs/02-cards-and-collection.md section 5.
 *
 * A pack is one or more slots and every slot is a PlayerCard. What varies between packs is
 * how many slots there are, the odds behind each one, whether the slots are spread one per
 * lane, and whether one of them carries a guaranteed floor — all of it read from the
 * pack_types table rather than written here, because prices and drop rates are the numbers
 * most likely to need changing without a deploy.
 *
 * Three things make a roll feel fair rather than random:
 *   - pity, visible in the UI, so a dry run has a known end
 *   - a bias toward the role the manager has least of, so nobody is stuck without a jungler
 *   - a preference for cards not yet owned, inside the band that was rolled
 *
 * The last one is not in the spec. It is here because the seed catalogue is a highlights
 * set with 11 commons in it: without it a new manager pulls the same four COMMON cards in
 * their first week. It falls back to a duplicate (XP, per section 5.3) when a band is
 * exhausted, so it never blocks a roll.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type Rarity = 'COMMON' | 'RARE' | 'EPIC' | 'LEGENDARY' | 'ICON';

export const BAND_WEIGHTS: Array<[Rarity, number]> = [
  ['COMMON', 52],
  ['RARE', 30],
  ['EPIC', 13],
  ['LEGENDARY', 4.4],
  ['ICON', 0.6],
];

/** Pity thresholds, per docs/02 section 5.2. */
export const PITY = { legendary: 40, icon: 150 };

/** When the Legendary guarantee pays out, the share of the time it pays an Icon instead. */
export const PITY_ICON_SHARE = 0.12;

/** The share of slots (outside one-per-lane packs) aimed at the manager's thinnest role. */
export const ROLE_BIAS = 0.3;

const ORDER: Rarity[] = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON'];
const ROLES = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];

export function rollBand(rng: () => number, pity: { since_legendary: number; since_icon: number }): {
  band: Rarity;
  forcedBy: 'icon-pity' | 'legendary-pity' | null;
} {
  if (pity.since_icon >= PITY.icon - 1) return { band: 'ICON', forcedBy: 'icon-pity' };
  if (pity.since_legendary >= PITY.legendary - 1) {
    // Guaranteed Legendary *or better*, which is what "Legendary+" means.
    return { band: rng() < PITY_ICON_SHARE ? 'ICON' : 'LEGENDARY', forcedBy: 'legendary-pity' };
  }

  const total = BAND_WEIGHTS.reduce((n, [, w]) => n + w, 0);
  let roll = rng() * total;
  for (const [band, weight] of BAND_WEIGHTS) {
    roll -= weight;
    if (roll <= 0) return { band, forcedBy: null };
  }
  return { band: 'COMMON', forcedBy: null };
}

/** The role with the fewest owned cards; ties broken by the given order. */
export function thinnestRole(owned: Array<{ role: string | null }>): string {
  const counts = new Map(ROLES.map((r) => [r, 0]));
  for (const c of owned) {
    if (c.role && counts.has(c.role)) counts.set(c.role, (counts.get(c.role) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => a[1] - b[1] || ROLES.indexOf(a[0]) - ROLES.indexOf(b[0]));
  return ranked[0]?.[0] ?? 'MID';
}

// --- packs with more than one slot -------------------------------------------

export interface PackType {
  key: string;
  name: string;
  slots: number;
  one_per_role: boolean;
  weights: Record<string, number>;
  floor_band: Rarity | null;
  max_band: Rarity | null;
  price: number;
  daily_limit: number | null;
}

export interface Pick {
  slot: number;
  cardId: string;
  cardKey: string;
  band: Rarity;
  role: string | null;
  forcedBy: 'icon-pity' | 'legendary-pity' | 'pack-floor' | null;
  wasDuplicate: boolean;
}

export interface PityState {
  since_legendary: number;
  since_icon: number;
  packs_opened: number;
}

const atLeast = (band: Rarity, floor: Rarity) => ORDER.indexOf(band) >= ORDER.indexOf(floor);

/** Weighted pick from a pack's own table, never above the pack's ceiling. */
function bandFromWeights(rng: () => number, weights: Record<string, number>, maxBand: Rarity | null): Rarity {
  const allowed = ORDER.filter((b) => {
    if (maxBand && ORDER.indexOf(b) > ORDER.indexOf(maxBand)) return false;
    return (weights[b] ?? 0) > 0;
  });
  if (!allowed.length) return 'COMMON';

  const total = allowed.reduce((n, b) => n + (weights[b] ?? 0), 0);
  let roll = rng() * total;
  for (const b of allowed) {
    roll -= weights[b] ?? 0;
    if (roll <= 0) return b;
  }
  return allowed[allowed.length - 1] ?? 'COMMON';
}

/**
 * Open one pack of any shape.
 *
 * A pack is `slots` draws against that pack's own odds, sharing one manager's pity and one
 * set of already-drawn cards, so a five-card pack cannot hand over the same player twice.
 *
 * Two pack-level rules sit on top of the per-slot roll:
 *
 * - `one_per_role` fills slot i with role i, which is what makes the Signing pack a squad
 *   rather than five strangers. It is why that pack has exactly five slots.
 * - `floor_band` guarantees one slot at that band or better, and it is applied to the *last*
 *   slot. That is a presentation decision as much as a mechanical one: the guaranteed card
 *   is the one the reveal ends on.
 *
 * Pity advances per card rather than per pack. A five-card pack moves the counter five
 * times, which is the only reading that keeps "Legendary within 40" an honest promise.
 */
export async function rollOpening(opts: {
  db: SupabaseClient;
  profileId: string;
  catalogueVersionId: string;
  pack: PackType;
  rng?: () => number;
}): Promise<{ picks: Pick[]; pity: PityState }> {
  const { db, profileId, catalogueVersionId, pack } = opts;
  const rng = opts.rng || Math.random;

  const [{ data: pityRow }, { data: ownedRows }] = await Promise.all([
    db.from('pity_counters').select('since_legendary, since_icon, packs_opened').eq('profile_id', profileId).maybeSingle(),
    db.from('collection_cards')
      .select('card_definition_id, card_definitions!inner(role)')
      .eq('profile_id', profileId),
  ]);

  const owned = (ownedRows || []) as unknown as Array<{ card_definition_id: string; card_definitions: { role: string | null } }>;
  const ownedIds = new Set(owned.map((o) => o.card_definition_id));
  const pity: PityState = {
    since_legendary: pityRow?.since_legendary ?? 0,
    since_icon: pityRow?.since_icon ?? 0,
    packs_opened: pityRow?.packs_opened ?? 0,
  };

  // One fetch per (band, role) for the whole opening. Without this a five-slot pack would
  // page the COMMON band — 1677 rows — once per slot.
  const cache = new Map<string, Array<{ id: string; card_key: string }>>();
  const candidates = async (band: Rarity, role: string | null) => {
    const key = `${band}|${role ?? ''}`;
    const hit = cache.get(key);
    if (hit) return hit;

    const rows: Array<{ id: string; card_key: string }> = [];
    for (let from = 0; ; from += 1000) {
      let q = db.from('card_definitions')
        .select('id, card_key')
        .eq('catalogue_version_id', catalogueVersionId)
        .eq('kind', 'PLAYER')
        .eq('rarity', band)
        .range(from, from + 999);
      if (role) q = q.eq('role', role);
      const { data } = await q;
      if (!data?.length) break;
      rows.push(...data);
      if (data.length < 1000) break;
    }
    cache.set(key, rows);
    return rows;
  };

  const picks: Pick[] = [];
  const takenInThisPack = new Set<string>();
  const floorSlot = pack.floor_band ? pack.slots - 1 : -1;

  for (let slot = 0; slot < pack.slots; slot++) {
    const role = pack.one_per_role
      ? (ROLES[slot % ROLES.length] ?? null)
      : (rng() < ROLE_BIAS ? thinnestRole(owned.map((o) => ({ role: o.card_definitions?.role ?? null }))) : null);

    let forcedBy: Pick['forcedBy'] = null;
    let band: Rarity;

    // Pity outranks the pack's own table: a pack cannot postpone a guarantee the manager
    // has already earned, even one whose ceiling sits below it.
    if (pity.since_icon >= PITY.icon - 1) {
      band = 'ICON';
      forcedBy = 'icon-pity';
    } else if (pity.since_legendary >= PITY.legendary - 1) {
      band = rng() < PITY_ICON_SHARE ? 'ICON' : 'LEGENDARY';
      forcedBy = 'legendary-pity';
    } else {
      band = bandFromWeights(rng, pack.weights, pack.max_band);
      if (slot === floorSlot && pack.floor_band && !atLeast(band, pack.floor_band)) {
        band = pack.floor_band;
        forcedBy = 'pack-floor';
      }
    }

    // A band with nothing left in it steps outward rather than failing the pack.
    let pool: Array<{ id: string; card_key: string }> = [];
    let bandUsed = band;
    const tryBand = async (b: Rarity, withRole: string | null) => {
      const all = await candidates(b, withRole);
      return all.filter((c) => !takenInThisPack.has(c.id));
    };

    pool = await tryBand(band, role);
    if (!pool.length && role) pool = await tryBand(band, null);
    if (!pool.length) {
      const start = ORDER.indexOf(band);
      for (let step = 1; step < ORDER.length && !pool.length; step++) {
        for (const idx of [start - step, start + step]) {
          if (idx < 0 || idx >= ORDER.length) continue;
          const stepBand = ORDER[idx];
          if (!stepBand) continue;
          const found = await tryBand(stepBand, null);
          if (found.length) { pool = found; bandUsed = stepBand; break; }
        }
      }
    }
    if (!pool.length) {
      throw new Error('the active catalogue has no player cards — run scripts/push-catalogue.mjs');
    }

    // Prefer a card the manager does not have, inside the band that was rolled.
    const fresh = pool.filter((c) => !ownedIds.has(c.id));
    const from = fresh.length ? fresh : pool;
    const picked = from[Math.floor(rng() * from.length)];
    if (!picked) throw new Error('pack roll found a band with no card left in it');

    takenInThisPack.add(picked.id);
    picks.push({
      slot,
      cardId: picked.id,
      cardKey: picked.card_key,
      band: bandUsed,
      role,
      forcedBy,
      wasDuplicate: ownedIds.has(picked.id),
    });

    pity.packs_opened += 1;
    pity.since_legendary = (bandUsed === 'LEGENDARY' || bandUsed === 'ICON') ? 0 : pity.since_legendary + 1;
    pity.since_icon = bandUsed === 'ICON' ? 0 : pity.since_icon + 1;
  }

  return { picks, pity };
}

/** XP for a duplicate, per docs/02 section 5.3. */
export const DUPLICATE_XP = 250;

/**
 * Credits for a duplicate, by what was pulled.
 *
 * docs/02 section 5.3 pays Credits only for a duplicate of a level-10 card, and a mastery
 * token otherwise. Tokens do not exist yet, so a duplicate would otherwise be XP and
 * nothing else — and with no match loop wired up, nothing in the game would produce
 * Credits at all except a hand-written grant. Paying every duplicate keeps the economy
 * turning while the rest of docs/01 section 5 is still unbuilt.
 */
export const DUPLICATE_CREDITS: Record<Rarity, number> = {
  COMMON: 15,
  RARE: 30,
  EPIC: 60,
  LEGENDARY: 150,
  ICON: 400,
};

/** Flat curve for v1: 400 XP a level, cap 10. */
export function applyXp(level: number, xp: number, gain: number) {
  let nextLevel = level;
  let nextXp = xp + gain;
  while (nextLevel < 10 && nextXp >= 400) {
    nextXp -= 400;
    nextLevel += 1;
  }
  if (nextLevel >= 10) nextXp = Math.min(nextXp, 399);
  return { level: nextLevel, xp: nextXp };
}
