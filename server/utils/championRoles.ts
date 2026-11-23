import type { SupabaseClient } from '@supabase/supabase-js';
import type { Slot } from '~~/shared/draft';
import { championKey as canonicalKey } from '~~/packages/card-engine/src/champions.js';

/**
 * Which lane each champion actually belongs to, derived from the catalogue.
 *
 * `roleFit` (docs/02 section 2.4) needs to know a champion's native role to charge anything
 * for taking it off-role, and nothing in the project knew one. Data Dragon does not say —
 * it has classes, not lanes, and a class does not decide where a champion is played.
 *
 * The catalogue does know, because it is a record of where champions were actually played.
 * docs/03 section 7 already specifies the rule: a champion is flex in a role when at least
 * 10% of professional games on it were played there. That is what this computes, over every
 * card in the pinned catalogue version.
 *
 * Keys are canonical Data Dragon ids (champions.js), so the old seed's "Wukong" and
 * "MonkeyKing" — one champion stored under two keys — are counted as the one champion they
 * are, and a lookup by either finds it.
 *
 * Cached per catalogue version in module scope. A catalogue is immutable once published
 * (docs/03 section 9), so there is nothing to invalidate.
 */

const MIN_FLEX_SHARE = 0.1;

export interface ChampionRoles {
  /** The role the champion is played in most. */
  primary: Slot;
  /** Every role with at least a 10% share, primary included. */
  flex: Set<Slot>;
  games: number;
}

const cache = new Map<string, Map<string, ChampionRoles>>();

export async function championRoles(
  db: SupabaseClient,
  catalogueVersionId: string,
): Promise<Map<string, ChampionRoles>> {
  const hit = cache.get(catalogueVersionId);
  if (hit) return hit;

  // Games per (champion, role), read off the pools of every card in this catalogue.
  const totals = new Map<string, Map<Slot, number>>();

  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('card_champion_pool')
      .select('champion_key, games, card_definitions!inner(role, catalogue_version_id)')
      .eq('card_definitions.catalogue_version_id', catalogueVersionId)
      // A stable order, or pages can repeat rows and skip others.
      .order('card_definition_id')
      .order('champion_key')
      .range(from, from + 999);

    if (error) throw error;
    if (!data?.length) break;

    for (const row of data as any[]) {
      const role = row.card_definitions?.role as Slot | null;
      if (!role) continue;
      const key = canonicalKey(row.champion_key);
      if (!key) continue;
      if (!totals.has(key)) totals.set(key, new Map());
      const byRole = totals.get(key)!;
      byRole.set(role, (byRole.get(role) || 0) + (Number(row.games) || 0));
    }
    if (data.length < 1000) break;
  }

  const out = new Map<string, ChampionRoles>();
  for (const [champion, byRole] of totals) {
    const games = [...byRole.values()].reduce((n, v) => n + v, 0);
    if (!games) continue;

    const ranked = [...byRole.entries()].sort((a, b) => b[1] - a[1]);
    const primary = ranked[0]![0];
    const flex = new Set<Slot>(ranked.filter(([, n]) => n / games >= MIN_FLEX_SHARE).map(([r]) => r));
    flex.add(primary);
    out.set(champion, { primary, flex, games });
  }

  cache.set(catalogueVersionId, out);
  return out;
}

/**
 * The champion role to hand `effRating`.
 *
 * `roleFit` in packages/core takes one role and scores an exact match at 1.0, an adjacent
 * lane at 0.94 and anything else at 0.88. It has no separate flex tier, so a champion played
 * in a lane often enough to count as flex is charged nothing for it here — which is the
 * closest honest reading available, and a little kinder than the 0.90 docs/02 section 2.4
 * describes. Worth revisiting together with roleFit rather than faked from this side.
 *
 * A champion nobody has played in this catalogue is treated as native wherever it is put.
 * Charging an off-role penalty for the pipeline's ignorance would be the pipeline's mistake
 * landing on the player, and docs/03 is consistent that unmeasured must not mean bad.
 */
export function roleForFit(roles: Map<string, ChampionRoles>, championKey: string, slot: Slot): Slot {
  const entry = roles.get(canonicalKey(championKey));
  if (!entry) return slot;
  return entry.flex.has(slot) ? slot : entry.primary;
}
