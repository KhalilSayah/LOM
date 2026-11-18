import type { SupabaseClient } from '@supabase/supabase-js';
import { normaliseShareCode } from '~~/shared/shareCode';
import type { Manager } from '~~/server/utils/auth';

/**
 * Resolving codes and summarising collections.
 *
 * Everything here runs with the service-role key, because the whole point of a share
 * code is to read a row RLS would otherwise hide: another manager's profile and what
 * they have collected. The code is the authorisation, so these helpers never take an
 * id from a request — only a code, which has to match a row — and they return a fixed
 * shape rather than passing a row through, so a column added to `profiles` later is
 * not published by accident.
 */

const BANDS = ['ICON', 'LEGENDARY', 'EPIC', 'RARE', 'COMMON'] as const;

export interface PublicManager {
  id: string;
  handle: string;
  displayName: string;
  shareCode: string;
  joinedAt: string;
}

export interface CollectionSummary {
  total: number;
  bands: Record<string, number>;
  /** The card they would show you first. Null if the collection is empty. */
  best: { playerName: string; season: number | null; ovr: number; rarity: string } | null;
}

export const EMPTY_SUMMARY: CollectionSummary = { total: 0, bands: {}, best: null };

const toPublic = (row: any): PublicManager => ({
  id: row.id,
  handle: row.handle,
  displayName: row.display_name,
  shareCode: row.share_code,
  joinedAt: row.created_at,
});

/**
 * The manager that code belongs to.
 *
 * Throws the same way for a malformed code and for one that matches nothing, in the
 * person's words rather than the database's — there is no useful distinction between
 * "that is not a code" and "that is not anyone's code" when you have mistyped one
 * character, and no reason to confirm which eight-character strings exist.
 */
export async function managerByCode(db: SupabaseClient, raw: string | null | undefined) {
  const code = normaliseShareCode(raw);
  if (!code) {
    throw createError({
      statusCode: 400,
      statusMessage: 'A share code is eight characters, like 7K2M-4QXP.',
    });
  }

  const { data, error } = await db
    .from('profiles')
    .select('id, handle, display_name, share_code, created_at')
    .eq('share_code', code)
    .maybeSingle();

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });
  if (!data) {
    throw createError({ statusCode: 404, statusMessage: 'No manager has that code.' });
  }

  return toPublic(data);
}

/** The managers behind a set of ids, in the order the ids were given. */
export async function managersByIds(db: SupabaseClient, ids: string[]): Promise<PublicManager[]> {
  if (!ids.length) return [];

  const { data, error } = await db
    .from('profiles')
    .select('id, handle, display_name, share_code, created_at')
    .in('id', ids);

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  const byId = new Map((data || []).map((row: any) => [row.id, toPublic(row)]));
  return ids.map((id) => byId.get(id)).filter(Boolean) as PublicManager[];
}

/**
 * Card count, rarity tally and headline card for several managers at once.
 *
 * One query for the whole list rather than one per manager: the discovery screen
 * renders every found manager with their numbers on it, and that is a query per
 * widget if this takes a single id.
 */
export async function summariseCollections(
  db: SupabaseClient,
  ids: string[],
): Promise<Map<string, CollectionSummary>> {
  const out = new Map<string, CollectionSummary>();
  for (const id of ids) out.set(id, { total: 0, bands: {}, best: null });
  if (!ids.length) return out;

  const { data, error } = await db
    .from('collection_cards')
    .select('profile_id, card_definitions ( player_name, season, ovr, rarity )')
    .in('profile_id', ids);

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  for (const row of (data || []) as any[]) {
    const card = row.card_definitions;
    const summary = out.get(row.profile_id);
    if (!card || !summary) continue;

    summary.total += 1;
    summary.bands[card.rarity] = (summary.bands[card.rarity] || 0) + 1;

    const better = !summary.best
      || BANDS.indexOf(card.rarity) < BANDS.indexOf(summary.best.rarity as any)
      || (card.rarity === summary.best.rarity && card.ovr > summary.best.ovr);

    if (better) {
      summary.best = {
        playerName: card.player_name,
        season: card.season ?? null,
        ovr: card.ovr,
        rarity: card.rarity,
      };
    }
  }

  return out;
}

/**
 * Remember that this seeker has found this manager.
 *
 * Idempotent, and quiet about failing: the discovery row is a convenience — the
 * widget that saves you keeping the code — so a write that loses a race or hits a
 * profile deleted a moment ago must not turn a successful lookup into an error.
 */
export async function rememberDiscovery(db: SupabaseClient, seeker: Manager, foundId: string) {
  if (foundId === seeker.id) return;

  await db
    .from('discoveries')
    .upsert(
      { seeker_id: seeker.id, found_id: foundId },
      { onConflict: 'seeker_id,found_id', ignoreDuplicates: true },
    );
}
