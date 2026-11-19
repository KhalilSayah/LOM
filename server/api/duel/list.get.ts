import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';

/**
 * Every duel this manager is part of, split by what it wants from them.
 *
 * `incoming` is the only one that needs a decision, so it is what the badge counts and
 * what the screen puts first.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const { data } = await db
    .from('duels')
    .select('id, status, challenger_id, opponent_id, blue_id, red_id, turn, result, created_at, completed_at')
    .or(`challenger_id.eq.${profileId},opponent_id.eq.${profileId}`)
    .order('created_at', { ascending: false })
    .limit(40);

  const rows = data || [];
  const others = [...new Set(rows.map((d) => (d.challenger_id === profileId ? d.opponent_id : d.challenger_id)))];
  const { data: profiles } = others.length
    ? await db.from('profiles').select('id, handle, display_name').in('id', others)
    : { data: [] as any[] };
  const byId = new Map((profiles || []).map((p: any) => [p.id, p]));

  const shape = (d: any) => {
    const otherId = d.challenger_id === profileId ? d.opponent_id : d.challenger_id;
    const other = byId.get(otherId);
    const mySide = d.blue_id === profileId ? 'BLUE' : d.red_id === profileId ? 'RED' : null;
    const winner = d.result?.winner ?? null;
    return {
      id: d.id,
      status: d.status,
      opponent: other?.display_name || other?.handle || 'Unknown manager',
      opponentHandle: other?.handle ?? null,
      iChallenged: d.challenger_id === profileId,
      side: mySide,
      turn: d.turn,
      createdAt: d.created_at,
      completedAt: d.completed_at,
      // Only meaningful once complete; null while a draft is still running.
      won: winner && mySide ? winner === mySide : null,
    };
  };

  return {
    incoming: rows.filter((d) => d.status === 'PENDING' && d.opponent_id === profileId).map(shape),
    outgoing: rows.filter((d) => d.status === 'PENDING' && d.challenger_id === profileId).map(shape),
    drafting: rows.filter((d) => d.status === 'DRAFTING').map(shape),
    finished: rows.filter((d) => d.status === 'COMPLETE').map(shape),
  };
});
