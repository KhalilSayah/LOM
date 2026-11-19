import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { snapshotLineup, lineupComplete } from '~~/server/utils/duel';

/**
 * Challenge another manager to a duel.
 *
 * Only the challenger's lineup is checked here. The opponent's is checked when they accept,
 * because refusing a challenge on the strength of someone else's roster would tell you
 * something about their collection that discovery does not otherwise show.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const body = await readBody<{ opponentId?: string }>(event);
  const opponentId = String(body?.opponentId ?? '').trim();

  if (!opponentId) throw createError({ statusCode: 400, statusMessage: 'Who do you want to play?' });
  if (opponentId === profileId) {
    throw createError({ statusCode: 400, statusMessage: 'You cannot duel yourself.' });
  }

  const { data: opponent } = await db
    .from('profiles').select('id, handle, display_name').eq('id', opponentId).maybeSingle();
  if (!opponent) throw createError({ statusCode: 404, statusMessage: 'No such manager.' });

  const lineup = await snapshotLineup(db, profileId);
  if (!lineupComplete(lineup)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Fill all five roster slots before challenging anyone.',
    });
  }

  const { data: active } = await db
    .from('catalogue_versions').select('id').eq('is_active', true).maybeSingle();
  if (!active) throw createError({ statusCode: 503, statusMessage: 'No active catalogue.' });

  const { data, error } = await db.from('duels').insert({
    challenger_id: profileId,
    opponent_id: opponentId,
    seed: `duel-${crypto.randomUUID()}`,
  }).select('id, status, created_at').single();

  if (error) {
    // The partial unique index: one live challenge in a given direction at a time.
    if (error.code === '23505') {
      throw createError({
        statusCode: 409,
        statusMessage: `You already have a duel waiting with ${opponent.display_name || opponent.handle}.`,
      });
    }
    throw createError({ statusCode: 500, statusMessage: error.message });
  }

  return { duelId: data.id, status: data.status, opponent: opponent.display_name || opponent.handle };
});
