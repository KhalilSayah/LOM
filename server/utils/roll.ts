/**
 * The pack roll — docs/02-cards-and-collection.md section 5.
 *
 * v1 is one slot and it is always a PlayerCard: no tokens, no coaches, no credits, because
 * none of those have anything to spend themselves on yet.
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

const ORDER: Rarity[] = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON'];
const ROLES = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];

export function rollBand(rng: () => number, pity: { since_legendary: number; since_icon: number }): {
  band: Rarity;
  forcedBy: 'icon-pity' | 'legendary-pity' | null;
} {
  if (pity.since_icon >= PITY.icon - 1) return { band: 'ICON', forcedBy: 'icon-pity' };
  if (pity.since_legendary >= PITY.legendary - 1) {
    // Guaranteed Legendary *or better*, which is what "Legendary+" means.
    return { band: rng() < 0.12 ? 'ICON' : 'LEGENDARY', forcedBy: 'legendary-pity' };
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
  return [...counts.entries()].sort((a, b) => a[1] - b[1] || ROLES.indexOf(a[0]) - ROLES.indexOf(b[0]))[0][0];
}

export interface RollResult {
  cardId: string;
  cardKey: string;
  band: Rarity;
  bandRolled: Rarity;
  forcedBy: 'icon-pity' | 'legendary-pity' | null;
  roleBiased: boolean;
  wasDuplicate: boolean;
}

/**
 * Pick one card. Everything is read through the service-role client; the caller is the
 * pack endpoint, which has already established who the manager is.
 */
export async function rollPack(opts: {
  db: SupabaseClient;
  profileId: string;
  catalogueVersionId: string;
  rng?: () => number;
}): Promise<RollResult> {
  const { db, profileId, catalogueVersionId } = opts;
  const rng = opts.rng || Math.random;

  const [{ data: pityRow }, { data: ownedRows }] = await Promise.all([
    db.from('pity_counters').select('since_legendary, since_icon').eq('profile_id', profileId).maybeSingle(),
    db.from('collection_cards')
      .select('card_definition_id, card_definitions!inner(role)')
      .eq('profile_id', profileId),
  ]);

  const pity = pityRow || { since_legendary: 0, since_icon: 0 };
  const owned = (ownedRows || []) as Array<{ card_definition_id: string; card_definitions: { role: string | null } }>;
  const ownedIds = new Set(owned.map((o) => o.card_definition_id));

  const { band, forcedBy } = rollBand(rng, pity);

  // 30% of pulls lean toward the thinnest role (docs/02 section 5.2).
  const roleBiased = rng() < 0.3;
  const role = roleBiased ? thinnestRole(owned.map((o) => ({ role: o.card_definitions?.role ?? null }))) : null;

  const pickFrom = async (b: Rarity, withRole: string | null) => {
    let q = db.from('card_definitions')
      .select('id, card_key')
      .eq('catalogue_version_id', catalogueVersionId)
      .eq('kind', 'PLAYER')
      .eq('rarity', b);
    if (withRole) q = q.eq('role', withRole);
    const { data } = await q;
    return data || [];
  };

  // Band first, role second: a role bias must never silently change what you pulled.
  let candidates = await pickFrom(band, role);
  if (!candidates.length && role) candidates = await pickFrom(band, null);

  // An empty band steps down, then up, rather than failing the claim.
  let bandUsed: Rarity = band;
  if (!candidates.length) {
    const start = ORDER.indexOf(band);
    for (let step = 1; step < ORDER.length && !candidates.length; step++) {
      for (const idx of [start - step, start + step]) {
        if (idx < 0 || idx >= ORDER.length) continue;
        candidates = await pickFrom(ORDER[idx], null);
        if (candidates.length) { bandUsed = ORDER[idx]; break; }
      }
    }
  }

  if (!candidates.length) {
    throw new Error('the active catalogue has no player cards — run scripts/push-catalogue.mjs');
  }

  const fresh = candidates.filter((c) => !ownedIds.has(c.id));
  const pool = fresh.length ? fresh : candidates;
  const picked = pool[Math.floor(rng() * pool.length)];

  return {
    cardId: picked.id,
    cardKey: picked.card_key,
    band: bandUsed,
    bandRolled: band,
    forcedBy,
    roleBiased: Boolean(role),
    wasDuplicate: ownedIds.has(picked.id),
  };
}

/** XP for a duplicate, per docs/02 section 5.3. */
export const DUPLICATE_XP = 250;

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
