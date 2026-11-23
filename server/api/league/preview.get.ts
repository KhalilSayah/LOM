import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { leagueByCode, membersOf, formatMatchHour, rosterReadiness } from '~~/server/utils/league';
import { MAX_MANAGERS, seasonShape } from '~~/shared/league';
import { ROLES } from '~~/shared/roster';

/**
 * What an invite link shows before you accept it.
 *
 * Joining a league is a commitment to turn up at a particular hour every evening for
 * a fortnight, so the link does not join you — it tells you whose league it is, who
 * is already in it and when they play, and lets you decide. The code is enough to
 * read this and nothing more: no collections, no emails, no uuids that would let the
 * holder of a code act on anybody in it.
 *
 * It does say one thing about the person reading it: whether they have anything to
 * play with yet. A brand-new account arrives here from a group chat with no cards and
 * a welcome pack it has not opened, and "you bring the collection you already have" is
 * no help to somebody whose collection is empty.
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

  const [readiness, { count: cards }, { count: gifts }] = await Promise.all([
    rosterReadiness(db, [profileId]),
    db.from('collection_cards').select('id', { count: 'exact', head: true }).eq('profile_id', profileId),
    db.from('pack_gifts').select('id', { count: 'exact', head: true })
      .eq('profile_id', profileId).is('opened_at', null),
  ]);

  // The season the reader would be joining: with them in it, if there is a seat.
  const shape = seasonShape(Math.min(MAX_MANAGERS, members.length + 1));

  return {
    league: {
      id: league.id,
      name: league.name,
      status: league.status,
      timezone: league.timezone,
      matchHour: formatMatchHour(league.match_hour),
      /** Derived from the league's size — see shared/league.ts `seasonShape`. */
      seasonLengthDays: shape.totalDays,
      matchDays: shape.matchDays,
      memberCount: members.length,
      maxMembers: MAX_MANAGERS,
    },
    host: host ? (host.display_name || host.handle) : 'Somebody',
    members: members.map((m) => ({ teamName: m.team_name, isOwner: m.is_owner })),
    alreadyIn: members.some((m) => m.profile_id === profileId),
    full: members.length >= MAX_MANAGERS,
    /** The reader's own state, so the invite can tell a new account what to do first. */
    me: {
      cards: cards ?? 0,
      rosterFilled: readiness.get(profileId) ?? 0,
      rosterSlots: ROLES.length,
      packsWaiting: gifts ?? 0,
    },
  };
});
