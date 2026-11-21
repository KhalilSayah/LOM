import type { SupabaseClient } from '@supabase/supabase-js';
import { normaliseLeagueCode, seasonSchedule, MAX_MANAGERS, MIN_MANAGERS } from '~~/shared/league';
import { ROLES } from '~~/shared/roster';
import { localNow, addDays, zonedToUtc } from './packDay';

/**
 * Leagues, server side: who is in one, and when they play.
 *
 * Everything in here runs with the service-role key, for the same reason the duel
 * routes do: "the league is full", "the season has already started" and "only the
 * owner starts it" are rules, and a rule the client could reach is a suggestion.
 * Membership is the authorisation — unlike discovery, where the share code is —
 * so every helper that reads a league takes the asking profile and checks it.
 *
 * The one thing deliberately not here is the collection. A league does not own
 * cards (see supabase/migrations/0009_leagues.sql for why), so a member's squad is
 * read through the same tables their own screens read.
 */

export const LEAGUE_SELECT = `
  id, name, owner_id, invite_code, timezone, match_hour, season_length_days,
  status, starts_on, created_at, started_at, catalogue_version_id,
  season, champion_member_id
`;

export interface LeagueRow {
  id: string;
  name: string;
  owner_id: string;
  invite_code: string;
  timezone: string;
  match_hour: string;
  season_length_days: number;
  status: 'FORMING' | 'ACTIVE' | 'FINISHED';
  starts_on: string | null;
  created_at: string;
  started_at: string | null;
  catalogue_version_id: string | null;
  /** Which season of this league is being played. 1 until a reset exists (docs/01 section 7). */
  season: number;
  /** Who won the grand final. Set at the same moment status becomes FINISHED. */
  champion_member_id: string | null;
}

export interface MemberRow {
  id: string;
  league_id: string;
  profile_id: string;
  team_name: string;
  is_owner: boolean;
  joined_at: string;
}

/** `'20:30:00'` -> `{ hour: 20, minute: 30 }`. Postgres hands back seconds; nobody needs them. */
export function matchHourParts(matchHour: string) {
  const [h, m] = String(matchHour || '20:30').split(':').map(Number);
  return { hour: Number.isFinite(h) ? h! : 20, minute: Number.isFinite(m) ? m! : 30 };
}

/** How the match hour is written on a screen. */
export const formatMatchHour = (matchHour: string) => {
  const { hour, minute } = matchHourParts(matchHour);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

/**
 * The league behind an invite code.
 *
 * Says the same thing for a malformed code and one that matches nothing — there is
 * no useful difference when you have mistyped a character, and no reason to confirm
 * which six-character strings are leagues.
 */
export async function leagueByCode(db: SupabaseClient, raw: string | null | undefined) {
  const code = normaliseLeagueCode(raw);
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'An invite code is six characters, like H7K2M4.' });
  }

  const { data, error } = await db
    .from('leagues').select(LEAGUE_SELECT).eq('invite_code', code).maybeSingle();

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });
  if (!data) throw createError({ statusCode: 404, statusMessage: 'No league has that code.' });

  return data as LeagueRow;
}

export async function membersOf(db: SupabaseClient, leagueId: string): Promise<MemberRow[]> {
  const { data, error } = await db
    .from('league_members')
    .select('id, league_id, profile_id, team_name, is_owner, joined_at')
    .eq('league_id', leagueId)
    .order('joined_at', { ascending: true });

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });
  return (data || []) as MemberRow[];
}

/**
 * A league this manager is actually in, with everyone in it.
 *
 * 404 rather than 403 for a league they are not a member of: whether a given uuid
 * is a league is not theirs to know.
 */
export async function requireMembership(db: SupabaseClient, leagueId: string, profileId: string) {
  const { data, error } = await db
    .from('leagues').select(LEAGUE_SELECT).eq('id', leagueId).maybeSingle();

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });
  if (!data) throw createError({ statusCode: 404, statusMessage: 'No such league.' });

  const league = data as LeagueRow;
  const members = await membersOf(db, leagueId);
  const me = members.find((m) => m.profile_id === profileId);

  if (!me) throw createError({ statusCode: 404, statusMessage: 'No such league.' });

  return { league, members, me };
}

/** The owner's own check, for the routes only they may call. */
export function requireOwner(league: LeagueRow, profileId: string) {
  if (league.owner_id !== profileId) {
    throw createError({ statusCode: 403, statusMessage: 'Only the manager who created the league can do that.' });
  }
}

// --- generating the season ---------------------------------------------------

/**
 * The calendar date day 1 falls on, in the league's own timezone.
 *
 * Today if the match hour has not come round yet — pressing Start season at lunchtime
 * means playing tonight, which is what everyone standing in the group chat expects —
 * and tomorrow otherwise, because a fixture whose kick-off has passed is a fixture
 * nobody can attend.
 */
export function firstMatchDate(league: LeagueRow, now = new Date()): string {
  const { hour, minute } = matchHourParts(league.match_hour);
  const local = localNow(league.timezone, now);
  const beforeKickOff = local.hour < hour || (local.hour === hour && local.minute < minute);
  return beforeKickOff ? local.date : addDays(local.date, 1);
}

export interface FixtureInsert {
  league_id: string;
  day_index: number;
  stage: 'REGULAR' | 'GHOST' | 'REST';
  blue_member_id: string | null;
  red_member_id: string | null;
  scheduled_at: string | null;
}

/**
 * Every row of the season, ready to insert.
 *
 * Pure apart from `now`, so the lobby can show the owner the calendar they are about
 * to commit six people to before they press the button, and get exactly the rows the
 * launch will write.
 */
export function buildFixtures(
  league: LeagueRow,
  members: MemberRow[],
  now = new Date(),
): FixtureInsert[] {
  const days = seasonSchedule(members.map((m) => m.id), league.season_length_days);
  const startsOn = firstMatchDate(league, now);
  const { hour, minute } = matchHourParts(league.match_hour);

  const rows: FixtureInsert[] = [];

  for (const day of days) {
    const date = addDays(startsOn, day.dayIndex - 1);
    const [y, m, d] = date.split('-').map(Number);
    const at = zonedToUtc(y!, m!, d!, hour, league.timezone, minute).toISOString();

    if (day.rest) {
      rows.push({
        league_id: league.id,
        day_index: day.dayIndex,
        stage: 'REST',
        blue_member_id: null,
        red_member_id: null,
        // A rest day has no kick-off. The pack still drops, on its own clock.
        scheduled_at: null,
      });
      continue;
    }

    for (const pairing of day.pairings) {
      rows.push({
        league_id: league.id,
        day_index: day.dayIndex,
        stage: pairing.red ? 'REGULAR' : 'GHOST',
        blue_member_id: pairing.blue,
        red_member_id: pairing.red,
        scheduled_at: at,
      });
    }
  }

  return rows;
}

/** The band check, in the words the owner needs to hear. */
export function assertLaunchable(members: MemberRow[]) {
  if (members.length < MIN_MANAGERS) {
    throw createError({
      statusCode: 400,
      statusMessage: `A season needs at least ${MIN_MANAGERS} managers. Share the invite code.`,
    });
  }
  if (members.length > MAX_MANAGERS) {
    throw createError({
      statusCode: 400,
      statusMessage: `A league holds at most ${MAX_MANAGERS} managers.`,
    });
  }
}

// --- shaping for the client --------------------------------------------------

/**
 * How ready each of these managers is to play: filled roster slots out of five.
 *
 * On the league screen this is the most useful thing to know about somebody else —
 * a manager with three slots filled cannot be challenged yet, and saying so beats
 * letting the challenge fail.
 */
export async function rosterReadiness(
  db: SupabaseClient,
  profileIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const id of profileIds) out.set(id, 0);
  if (!profileIds.length) return out;

  const { data, error } = await db
    .from('roster_slots').select('profile_id, role').in('profile_id', profileIds);

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  for (const row of (data || []) as any[]) {
    if (!ROLES.includes(row.role)) continue;
    out.set(row.profile_id, (out.get(row.profile_id) ?? 0) + 1);
  }

  return out;
}

export const shapeLeague = (league: LeagueRow, members: MemberRow[], profileId: string) => ({
  id: league.id,
  name: league.name,
  status: league.status,
  season: league.season ?? 1,
  finished: league.status === 'FINISHED',
  /**
   * The honours board's one entry. A member id, resolved to a team name by the caller,
   * which already has the members to hand.
   */
  championMemberId: league.champion_member_id ?? null,
  timezone: league.timezone,
  matchHour: formatMatchHour(league.match_hour),
  seasonLengthDays: league.season_length_days,
  startsOn: league.starts_on,
  createdAt: league.created_at,
  startedAt: league.started_at,
  memberCount: members.length,
  maxMembers: MAX_MANAGERS,
  iAmOwner: league.owner_id === profileId,
  /**
   * The code is shown to every member, not just the owner. Whoever is in the chat
   * when a friend asks to join is the person who should be able to answer, and the
   * code stops working as a way in the moment the season starts anyway.
   */
  inviteCode: league.status === 'FORMING' ? league.invite_code : null,
});
