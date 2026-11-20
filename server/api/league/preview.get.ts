import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { leagueByCode, membersOf, formatMatchHour } from '~~/server/utils/league';
import { MAX_MANAGERS } from '~~/shared/league';

/**
 * What an invite link shows before you accept it.
 *
 * Joining a league is a commitment to turn up at a particular hour every evening for
 * a fortnight, so the link does not join you — it tells you whose league it is, who
 * is already in it and when they play, and lets you decide. The code is enough to
 * read this and nothing more: no collections, no emails, no uuids that would let the
 * holder of a code act on anybody in it.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const league = await leagueByCode(db, getQuery(event).code as string | undefined);
  const members = await membersOf(db, league.id);

  const { data: profiles } = await db
    .from('profiles')
    .select('id, handle, display_name')
    .in('id', members.map((m) => m.profile_id));

  const byId = new Map((profiles || []).map((p: any) => [p.id, p]));
  const host = byId.get(league.owner_id);

  return {
    league: {
      id: league.id,
      name: league.name,
      status: league.status,
      timezone: league.timezone,
      matchHour: formatMatchHour(league.match_hour),
      seasonLengthDays: league.season_length_days,
      memberCount: members.length,
      maxMembers: MAX_MANAGERS,
    },
    host: host ? (host.display_name || host.handle) : 'Somebody',
    members: members.map((m) => ({ teamName: m.team_name, isOwner: m.is_owner })),
    alreadyIn: members.some((m) => m.profile_id === profileId),
    full: members.length >= MAX_MANAGERS,
  };
});
