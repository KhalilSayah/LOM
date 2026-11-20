import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { snapshotLineup, lineupComplete } from '~~/server/utils/duel';
import { ACTION_SECONDS, BONUS_SECONDS } from '~~/shared/draft';
import { LOBBY_SECONDS, WATCH_SPEED } from '~~/shared/duelRoom';

/**
 * Accept or decline a challenge.
 *
 * Accepting is the moment everything is pinned: both lineups are copied, the catalogue
 * version is fixed, and sides are drawn. Sides matter — blue has first ban and first pick,
 * red has last pick — so they are drawn here rather than handed to whoever sent the
 * challenge, which would make challenging someone worth a real advantage.
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
    .select('id, challenger_id, opponent_id, status')
    .eq('id', duelId)
    .maybeSingle();

  if (!duel) throw createError({ statusCode: 404, statusMessage: 'No such duel.' });
  if (duel.status !== 'PENDING') {
    throw createError({ statusCode: 409, statusMessage: 'That challenge has already been answered.' });
  }

  // Either side can walk away from a pending challenge; only the person challenged can accept.
  const isOpponent = duel.opponent_id === profileId;
  const isChallenger = duel.challenger_id === profileId;
  if (!isOpponent && !isChallenger) {
    throw createError({ statusCode: 403, statusMessage: 'That duel is not yours.' });
  }

  if (!accept) {
    await db.from('duels').update({
      status: isChallenger ? 'CANCELLED' : 'DECLINED',
      updated_at: new Date().toISOString(),
    }).eq('id', duel.id);
    return { duelId: duel.id, status: isChallenger ? 'CANCELLED' : 'DECLINED' };
  }

  if (!isOpponent) {
    throw createError({ statusCode: 403, statusMessage: 'You cannot accept your own challenge.' });
  }

  const [mine, theirs] = await Promise.all([
    snapshotLineup(db, profileId),
    snapshotLineup(db, duel.challenger_id),
  ]);

  if (!lineupComplete(mine)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Fill all five roster slots before accepting.',
    });
  }
  if (!lineupComplete(theirs)) {
    throw createError({
      statusCode: 409,
      statusMessage: 'They no longer have a full roster. The challenge cannot start.',
    });
  }

  const { data: active } = await db
    .from('catalogue_versions').select('id').eq('is_active', true).maybeSingle();
  if (!active) throw createError({ statusCode: 503, statusMessage: 'No active catalogue.' });

  const challengerIsBlue = Math.random() < 0.5;
  const blueId = challengerIsBlue ? duel.challenger_id : profileId;
  const redId = challengerIsBlue ? profileId : duel.challenger_id;

  /**
   * A friendly opens the same room a queue match does, with the same lobby.
   *
   * The challenger is not necessarily looking at their phone when this runs, so the lobby is
   * doing less here than it does for a queue match — but it costs the accepting player
   * nothing (it is inside the first action's deadline) and it means the draft screen has one
   * shape to render rather than two. The agent covers the challenger's first actions if they
   * are away, exactly as it always did.
   */
  const startsAt = new Date(Date.now() + LOBBY_SECONDS * 1000);

  const { error } = await db.from('duels').update({
    status: 'DRAFTING',
    source: 'CHALLENGE',
    blue_id: blueId,
    red_id: redId,
    blue_lineup: challengerIsBlue ? theirs : mine,
    red_lineup: challengerIsBlue ? mine : theirs,
    catalogue_version_id: active.id,
    turn: 0,
    bonus: { BLUE: BONUS_SECONDS, RED: BONUS_SECONDS },
    starts_at: startsAt.toISOString(),
    deadline_at: new Date(startsAt.getTime() + ACTION_SECONDS * 1000).toISOString(),
    watch_speed: WATCH_SPEED,
    accepted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', duel.id).eq('status', 'PENDING');

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  return { duelId: duel.id, status: 'DRAFTING', side: blueId === profileId ? 'BLUE' : 'RED' };
});
