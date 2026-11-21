import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { liveDuelFor } from '~~/server/utils/duelQueue';
import { challengeCutoff } from '~~/server/utils/duel';

/**
 * Counts only: how many challenges are waiting on you, and how many drafts are live.
 *
 * Separate from /api/duel/list because this one is read from the nav on every screen.
 * The list endpoint joins profiles and shapes every duel the manager has ever played,
 * which is a lot of work to decide whether to draw a dot.
 *
 * It also names the newest challenge and the live room's opponent, because the realtime
 * toast (useDuelSignal) is told *that* something happened by a push that carries ids only,
 * and asks here who it was.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const cutoff = challengeCutoff();
  const [{ count: incoming }, { data: newest }, liveId] = await Promise.all([
    db.from('duels')
      .select('id', { count: 'exact', head: true })
      .eq('opponent_id', profileId)
      .eq('status', 'PENDING')
      // A challenge older than a day has expired, whether or not anyone has written it off yet.
      .gte('created_at', cutoff),
    db.from('duels')
      .select('id, challenger_id, created_at')
      .eq('opponent_id', profileId)
      .eq('status', 'PENDING')
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(1),
    /**
     * A live room is a draft or a match still playing, and unlike a count it comes back with
     * an id. That matters: a room you are in is somewhere you should be put back rather than
     * merely told about, so the nav links straight to it.
     *
     * Through liveDuelFor rather than its own query, so there is one definition of "live".
     */
    liveDuelFor(db, profileId),
  ]);

  const latest = newest?.[0] ?? null;
  let latestIncoming: { id: string; from: string; at: string } | null = null;
  let liveOpponent: string | null = null;

  const [{ data: challenger }, { data: room }] = await Promise.all([
    latest
      ? db.from('profiles').select('handle, display_name').eq('id', latest.challenger_id).maybeSingle()
      : Promise.resolve({ data: null as any }),
    liveId
      ? db.from('duels').select('challenger_id, opponent_id, bot_side').eq('id', liveId).maybeSingle()
      : Promise.resolve({ data: null as any }),
  ]);

  if (latest) {
    latestIncoming = {
      id: latest.id,
      from: challenger?.display_name || challenger?.handle || 'A manager',
      at: latest.created_at,
    };
  }
  if (room) {
    if (room.bot_side) liveOpponent = 'The agent';
    else {
      const otherId = room.challenger_id === profileId ? room.opponent_id : room.challenger_id;
      const { data: other } = otherId
        ? await db.from('profiles').select('handle, display_name').eq('id', otherId).maybeSingle()
        : { data: null as any };
      liveOpponent = other?.display_name || other?.handle || 'your opponent';
    }
  }

  return {
    incoming: incoming ?? 0,
    drafting: liveId ? 1 : 0,
    liveDuelId: liveId,
    liveOpponent,
    latestIncoming,
  };
});
