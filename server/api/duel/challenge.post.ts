import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import {
  snapshotLineup, lineupComplete, newDuelSeed, expireStaleChallenges, challengeCutoff, acceptChallenge,
} from '~~/server/utils/duel';
import { assertNotInRoom } from '~~/server/utils/duelQueue';

/**
 * Challenge another manager to a duel.
 *
 * Only the challenger's lineup is checked here. The opponent's is checked when they accept,
 * because refusing a challenge on the strength of someone else's roster would tell you
 * something about their collection that discovery does not otherwise show.
 *
 * If they have already challenged you, this is an accept. Two people pressing Challenge on
 * each other want the same game, and leaving both challenges pending — each waiting on the
 * other to answer — is how that game used to not happen at all.
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
  const name = opponent.display_name || opponent.handle;

  // A challenge left unanswered for a day is gone, and must not block a fresh one.
  await expireStaleChallenges(db, profileId);

  // Theirs to me, still open: answer it rather than crossing it with a second one.
  const { data: reverse } = await db
    .from('duels')
    .select('id, challenger_id, opponent_id')
    .eq('status', 'PENDING')
    .eq('challenger_id', opponentId)
    .eq('opponent_id', profileId)
    .gte('created_at', challengeCutoff())
    .maybeSingle();

  if (reverse) {
    // Starting a room: neither of them may already be in one.
    await assertNotInRoom(db, profileId, opponentId);
    const accepted = await acceptChallenge(db, reverse as any, profileId);
    return { ...accepted, opponent: name, accepted: true };
  }

  // You cannot send one from inside a match: it would open a second room the moment it is
  // accepted. They may be mid-match — the challenge simply waits for them.
  await assertNotInRoom(db, profileId, null);

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
    // Re-drawn at accept anyway; never a value a client could have guessed.
    seed: newDuelSeed(),
  }).select('id, status, created_at').single();

  if (error) {
    // The partial unique index: one pending challenge between two managers at a time, in
    // either direction (migration 0015).
    if (error.code === '23505') {
      throw createError({
        statusCode: 409,
        statusMessage: `You already have a challenge waiting with ${name}.`,
      });
    }
    throw createError({ statusCode: 500, statusMessage: error.message });
  }

  return { duelId: data.id, status: data.status, opponent: name, accepted: false };
});
