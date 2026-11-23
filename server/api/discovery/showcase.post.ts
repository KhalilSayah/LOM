import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';

/**
 * Star or unstar one of your cards.
 *
 * Starred cards are your showcase: up to three, shown first to anyone who opens your
 * collection by code, and on their discovery list instead of your "Best" card. It lives
 * under discovery because that is who it is for — it changes nothing about the card in
 * your own game.
 *
 * A server route rather than a client write because collection_cards has no client write
 * policy, on purpose (0001): a policy loose enough to set a flag is loose enough to set a
 * level. The cap of three is checked here for a readable answer, and again by a trigger
 * (0017) so two taps at once cannot make it four.
 */
const SHOWCASE_SIZE = 3;

export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  await ensureProfile(db, manager);

  const body = await readBody<{ collectionCardId?: string; on?: boolean }>(event);
  const id = String(body?.collectionCardId || '');
  const on = body?.on === true;
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Which card?' });

  const { data: held, error: lookupError } = await db
    .from('collection_cards')
    .select('id, profile_id, is_favourite')
    .eq('id', id)
    .maybeSingle();

  if (lookupError) {
    // 42703: the column is not there yet — 0017 has not been run.
    if (lookupError.code === '42703') {
      throw createError({ statusCode: 503, statusMessage: 'Starring cards is not switched on yet.' });
    }
    throw createError({ statusCode: 500, statusMessage: lookupError.message });
  }

  // Same answer for "no such card" and "not yours", as /api/roster/slot does.
  if (!held || held.profile_id !== manager.id) {
    throw createError({ statusCode: 404, statusMessage: 'That card is not in your collection.' });
  }

  if (held.is_favourite === on) return { id, on };

  if (on) {
    const { count, error: countError } = await db
      .from('collection_cards')
      .select('id', { count: 'exact', head: true })
      .eq('profile_id', manager.id)
      .eq('is_favourite', true);

    if (countError) throw createError({ statusCode: 500, statusMessage: countError.message });
    if ((count ?? 0) >= SHOWCASE_SIZE) {
      throw createError({
        statusCode: 409,
        statusMessage: `Your showcase holds ${SHOWCASE_SIZE} cards. Unstar one first.`,
      });
    }
  }

  const { error } = await db
    .from('collection_cards')
    .update({ is_favourite: on })
    .eq('id', id)
    .eq('profile_id', manager.id);

  if (error) {
    if (error.code === '23514') {
      throw createError({ statusCode: 409, statusMessage: `Your showcase holds ${SHOWCASE_SIZE} cards. Unstar one first.` });
    }
    throw createError({ statusCode: 500, statusMessage: error.message });
  }

  return { id, on };
});
