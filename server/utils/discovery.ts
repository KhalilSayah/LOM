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

export interface ShowcaseCard {
  /** collection_cards.id, so a page holding the full list can find the card itself. */
  id: string;
  cardKey: string;
  playerName: string;
  season: number | null;
  ovr: number;
  rarity: string;
  role: string | null;
  team: string | null;
}

export interface CollectionSummary {
  total: number;
  bands: Record<string, number>;
  /** The card they would show you first. Null if the collection is empty. */
  best: { playerName: string; season: number | null; ovr: number; rarity: string } | null;
  /** Up to three cards they starred, rarest first. Empty until they star one. */
  showcase: ShowcaseCard[];
}

export const EMPTY_SUMMARY: CollectionSummary = { total: 0, bands: {}, best: null, showcase: [] };

/** PostgREST returns at most this many rows per request, whatever the query asks for. */
export const PAGE = 1000;

/**
 * Every row a query would return, a page at a time.
 *
 * PostgREST caps a response at 1000 rows and says nothing when it does, so any read that
 * can grow past that — a collection, a catalogue — has to page or it is quietly wrong.
 * `build` must apply a stable order, or rows can repeat or go missing between pages.
 */
export async function readAll<T = any>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw createError({ statusCode: 500, statusMessage: error.message });
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

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
 * Card count, rarity tally, headline card and showcase for several managers at once.
 *
 * One grouped query for the whole list (collection_summaries, migration 0017): the
 * discovery screen renders every found manager with their numbers on it, and counting
 * raw rows here was both a query's worth of rows per card and silently wrong past 1000.
 *
 * Until 0017 has been run the function does not exist, so this falls back to reading the
 * rows a page at a time and counting them here — slower, but right.
 */
export async function summariseCollections(
  db: SupabaseClient,
  ids: string[],
): Promise<Map<string, CollectionSummary>> {
  const out = new Map<string, CollectionSummary>();
  for (const id of ids) out.set(id, { total: 0, bands: {}, best: null, showcase: [] });
  if (!ids.length) return out;

  const { data, error } = await db.rpc('collection_summaries', { p_ids: ids });

  if (!error) {
    for (const row of (data || []) as any[]) {
      out.set(row.profile_id, {
        total: Number(row.total) || 0,
        bands: row.bands || {},
        best: row.best ?? null,
        showcase: Array.isArray(row.showcase) ? row.showcase : [],
      });
    }
    return out;
  }

  const rows = await readAll<any>((from, to) => db
    .from('collection_cards')
    .select('id, profile_id, card_definitions ( player_name, season, ovr, rarity )')
    .in('profile_id', ids)
    .order('id')
    .range(from, to));

  for (const row of rows) {
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
