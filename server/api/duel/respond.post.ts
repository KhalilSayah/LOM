import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { acceptChallenge, challengeCutoff } from '~~/server/utils/duel';
import { assertNotInRoom } from '~~/server/utils/duelQueue';

/**
 * Accept or decline a challenge.
 *
 * Accepting is the moment everything is pinned: both lineups are copied, the catalogue
 * version is fixed, and sides are drawn (acceptChallenge in server/utils/duel.ts).
 *
 * Three things are checked here that were not before, each because it went wrong:
 *   - neither manager may already be in a live room, or one of them drafts two games at once
 *     with the agent playing whichever they are not looking at;
 *   - the accept has to have actually changed the row — a challenge withdrawn in the same
 *     instant used to come back as DRAFTING and send somebody into a room that never opened;
 *   - a challenge older than a day has expired, and says so.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const body = await readBody<{ duelId?: string; accept?: boolean }>(event);
  const duelId = String(body?.duelId ?? '').trim();
  const accept = body?.accept === true;

  const { data: duel } = await db
    .from('duels')
    .select('id, challenger_id, opponent_id, status, created_at')
    .eq('id', duelId)
    .maybeSingle();

  if (!duel) throw createError({ statusCode: 404, statusMessage: 'No such duel.' });

  // Either side can walk away from a pending challenge; only the person challenged can accept.
  const isOpponent = duel.opponent_id === profileId;
  const isChallenger = duel.challenger_id === profileId;
  if (!isOpponent && !isChallenger) {
    throw createError({ statusCode: 403, statusMessage: 'That duel is not yours.' });
  }

  if (duel.status !== 'PENDING') {
    throw createError({ statusCode: 409, statusMessage: 'That challenge has already been answered.' });
  }

  // Expired: write it off on the way past, and say what happened.
  if (new Date(duel.created_at).getTime() < new Date(challengeCutoff()).getTime()) {
    await db.from('duels').update({
      status: 'CANCELLED',
      updated_at: new Date().toISOString(),
    }).eq('id', duel.id).eq('status', 'PENDING');
    throw createError({ statusCode: 409, statusMessage: 'That challenge expired after a day without an answer.' });
  }

  if (!accept) {
    const status = isChallenger ? 'CANCELLED' : 'DECLINED';
    await db.from('duels').update({
      status,
      updated_at: new Date().toISOString(),
    }).eq('id', duel.id).eq('status', 'PENDING');
    return { duelId: duel.id, status };
  }

  if (!isOpponent) {
    throw createError({ statusCode: 403, statusMessage: 'You cannot accept your own challenge.' });
  }

  await assertNotInRoom(db, profileId, duel.challenger_id);

  return acceptChallenge(db, duel as any, profileId);
});
