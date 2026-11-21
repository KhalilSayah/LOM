import type { SupabaseClient } from '@supabase/supabase-js';
import type { Slot } from '~~/shared/draft';
import { championRoles, roleForFit, type ChampionRoles } from './championRoles';

/**
 * Champion roles for the active catalogue, or null when they cannot be read.
 *
 * The Team screen and the sandbox rate a card the way a duel does (server/utils/duel.ts
 * ratingFor), and that needs each champion's native role for roleFit. Failing soft on
 * purpose: without it every champion reads as native, which is what championRoles itself
 * assumes for a champion it has no record of.
 */
export async function activeChampionRoles(db: SupabaseClient): Promise<Map<string, ChampionRoles> | null> {
  try {
    const { data } = await db.from('catalogue_versions').select('id').eq('is_active', true).maybeSingle();
    if (!data) return null;
    return await championRoles(db, (data as any).id);
  } catch {
    return null;
  }
}

/** Writes the champion role effRating should be handed onto each pool entry, in place. */
export function withFitRoles<T extends { role: string; championPool: { key: string }[] }>(
  card: T,
  roles: Map<string, ChampionRoles> | null,
): T {
  if (!roles) return card;
  for (const entry of card.championPool as { key: string; fitRole?: string }[]) {
    entry.fitRole = roleForFit(roles, entry.key, card.role as Slot);
  }
  return card;
}
