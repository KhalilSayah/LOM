import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { shapeLeague, draftedSides, type LeagueRow, type MemberRow } from '~~/server/utils/league';
import { fixtureWindow } from '~~/shared/league';

/**
 * Every league this manager is in.
 *
 * Plus the one thing that decides what the screen says next to each: whether tonight's
 * fixture exists, and who it is against. A list of league names is a menu; a list with
 * "vs Sam, 20:30 tonight" on it is the reason to open the app.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  /**
   * My memberships, each with its league.
   *
   * `leagues!league_id` and not plain `leagues`, and the hint is load-bearing. There are
   * now *two* foreign keys between these tables — `league_members.league_id -> leagues`
   * from 0009, and `leagues.champion_member_id -> league_members` from 0013 — so PostgREST
   * cannot pick one and refuses the whole request with "more than one relationship was
   * found". The hint names the column to travel along, which is the direction this screen
   * means: the league this membership is in, not the league this member won.
   *
   * Named by column rather than by constraint. `league_members_league_id_fkey` works too,
   * but it is a name Postgres generated — 0009 never wrote it down — whereas `league_id` is
   * spelled out in the DDL. Any future embed between these two tables, or between
   * `league_members` and `league_seasons` (0014 adds a champion there as well), needs the
   * same treatment.
   */
  const { data: mine, error } = await db
    .from('league_members')
    .select('id, league_id, leagues!league_id ( id, name, owner_id, invite_code, timezone, match_hour, season_length_days, status, starts_on, created_at, started_at, finished_at, catalogue_version_id, season, champion_member_id )')
    .eq('profile_id', profileId);

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  const rows = (mine || []).filter((r: any) => r.leagues);
  if (!rows.length) return { leagues: [] };

  const leagueIds = rows.map((r: any) => r.league_id);
  const myMemberIds = new Set(rows.map((r: any) => r.id));

  // Everyone in every one of those leagues, in one query rather than one per league.
  const { data: allMembers } = await db
    .from('league_members')
    .select('id, league_id, profile_id, team_name, is_owner, joined_at')
    .in('league_id', leagueIds);

  const byLeague = new Map<string, MemberRow[]>();
  for (const m of (allMembers || []) as MemberRow[]) {
    const list = byLeague.get(m.league_id) || [];
    list.push(m);
    byLeague.set(m.league_id, list);
  }
  for (const list of byLeague.values()) {
    list.sort((a, b) => a.joined_at.localeCompare(b.joined_at));
  }

  /**
   * The fixture each of my memberships still owes, earliest first.
   *
   * Undecided rather than future: a missed evening is still the next thing to play,
   * and showing tomorrow's instead would hide it. Ordered by kick-off and read in one
   * pass, so a league with a hundred rows costs the same as one with ten. Rest days
   * have no `scheduled_at` and so cannot win.
   */
  const { data: fixtures } = await db
    .from('league_fixtures')
    .select('league_id, season, day_index, stage, blue_member_id, red_member_id, ghost_side, scheduled_at, status, duel_id')
    .in('league_id', leagueIds)
    .not('scheduled_at', 'is', null)
    .neq('status', 'FINAL')
    .neq('status', 'VOID')
    .order('scheduled_at', { ascending: true });

  /**
   * Which season each league is currently playing, so a fixture from a previous one can
   * never be "next" (migration 0014). Old seasons are all decided and would be filtered
   * out by status anyway — except for a Ghost or a voided-but-not-voided row that nobody
   * ever played, which would otherwise sit at the top of this list for ever.
   */
  const seasonOf = new Map<string, number>();
  for (const row of rows as any[]) {
    const lg = row.leagues as LeagueRow;
    if (lg) seasonOf.set(lg.id, lg.season ?? 1);
  }

  const nextByLeague = new Map<string, any>();
  const now = Date.now();
  for (const f of (fixtures || []) as any[]) {
    if (nextByLeague.has(f.league_id)) continue;
    if ((f.season ?? 1) !== (seasonOf.get(f.league_id) ?? 1)) continue;
    // Sides as drafted: a Ghost on blue puts the manager on red (migration 0016).
    const sides = draftedSides(f);
    const mineSide = myMemberIds.has(sides.blue as string) ? 'BLUE'
      : myMemberIds.has(sides.red as string) ? 'RED' : null;
    if (!mineSide) continue;
    // A bye a day overdue is nobody's obligation, and should not sit here for ever.
    if (f.stage === 'GHOST' && !f.duel_id && fixtureWindow(f.scheduled_at, now).overdue) continue;
    nextByLeague.set(f.league_id, { ...f, mineSide, sides });
  }

  const leagues = rows.map((row: any) => {
    const league = row.leagues as LeagueRow;
    const members = byLeague.get(league.id) || [];
    const next = nextByLeague.get(league.id);
    const byMemberId = new Map(members.map((m) => [m.id, m]));

    const opponentId = next
      ? (next.mineSide === 'BLUE' ? next.sides.red : next.sides.blue)
      : null;
    const window = next ? fixtureWindow(next.scheduled_at, now) : null;

    return {
      ...shapeLeague(league, members, profileId),
      members: members.map((m) => ({ teamName: m.team_name, isOwner: m.is_owner })),
      next: next
        ? {
            dayIndex: next.day_index,
            stage: next.stage,
            scheduledAt: next.scheduled_at,
            side: next.mineSide,
            opponent: opponentId ? byMemberId.get(opponentId)?.team_name ?? 'Unknown' : 'A Ghost',
            /** Already in a room, so the list can say "rejoin" rather than "play". */
            duelId: next.duel_id ?? null,
            playable: Boolean(window?.open),
            /** True once kick-off has passed: "you are late" rather than "coming up". */
            started: Boolean(window?.started),
          }
        : null,
    };
  });

  /**
   * By my next fixture, soonest first — the list is where somebody checks what they play
   * next, so the league that wants them soonest is the one at the top. Then the leagues
   * still forming, which are waiting on a human; then everything else, finished last.
   */
  const rank = (l: any) => (l.next ? 0 : l.status === 'FORMING' ? 1 : l.status === 'ACTIVE' ? 2 : 3);
  leagues.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.next && b.next) return String(a.next.scheduledAt).localeCompare(String(b.next.scheduledAt));
    return a.name.localeCompare(b.name);
  });

  return { leagues };
});
