import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { stepAt, type Slot } from '~~/shared/draft';
import { sideOf } from '~~/server/utils/duelRun';

/**
 * Say what you are considering, before you commit to it.
 *
 * Deliberately cheap and deliberately not validated the way an action is: a hover is not a
 * claim on a champion, it is a thing to look at. Someone can hover a champion that is
 * already gone, change their mind twice a second, or hover nothing at all, and none of it
 * touches the draft. The action log still decides what happened.
 *
 * Writing it costs one update and no reads, which matters because this fires on every tap
 * while someone is deciding.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const id = getRouterParam(event, 'id');
  const body = await readBody<{ championKey?: string; championName?: string; slot?: string | null }>(event);

  const { data: duel } = await db
    .from('duels')
    .select('id, status, turn, blue_id, red_id')
    .eq('id', id)
    .maybeSingle();

  if (!duel) throw createError({ statusCode: 404, statusMessage: 'No such duel.' });

  const side = sideOf(duel, profileId);
  if (!side) throw createError({ statusCode: 403, statusMessage: 'That duel is not yours.' });
  if (duel.status !== 'DRAFTING') return { ok: false };

  const step = stepAt(duel.turn);
  // Only the side on the clock can hover. Otherwise one player could scribble over the
  // other's screen while they are trying to think.
  if (!step || step.side !== side) return { ok: false };

  const championKey = String(body?.championKey ?? '').trim();

  await db.from('duels').update({
    hover: championKey
      ? {
          side,
          kind: step.kind,
          turn: duel.turn,
          championKey,
          championName: String(body?.championName ?? ''),
          slot: (body?.slot ? String(body.slot) : null) as Slot | null,
          at: new Date().toISOString(),
        }
      : null,
  }).eq('id', duel.id);

  return { ok: true };
});
