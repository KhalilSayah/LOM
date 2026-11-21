import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { summariseCollections } from '~~/server/utils/discovery';
import {
  requireMembership, shapeLeague, rosterReadiness, buildFixtures,
} from '~~/server/utils/league';
import { fixtureWindow } from '~~/shared/league';
import { standings } from '~~/shared/standings';
import { loadBracket, isPlayoffStage } from '~~/server/utils/leaguePlayoffs';
import { seasonPayouts } from '~~/server/utils/seasonRewards';
import { honoursOf } from '~~/server/utils/leagueSeason';
import { seasonPlacingCredits } from '~~/shared/rewards';
import { ROLES } from '~~/shared/roster';

/**
 * Everything the league screen draws, in one response.
 *
 * One round trip on purpose: the screen is a table of people and a calendar, and
 * both are small. Fetching the members, then their collections, then the schedule
 * would give a screen that assembles itself in three visible steps every time
 * somebody opens it to check who they play tonight.
 *
 * While a league is FORMING there are no fixtures yet, so the schedule comes back as
 * a *preview* built by the same function the launch will use. The owner is about to
 * commit five other people to a fortnight of evenings; they should see the shape of
 * it first, and see it change as people join.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Which league?' });

  const { league, members, me } = await requireMembership(db, id, profileId);
  const profileIds = members.map((m) => m.profile_id);

  const [{ data: profiles }, summaries, readiness, { data: fixtures }, { data: duels }] =
    await Promise.all([
      db.from('profiles').select('id, handle, display_name, share_code').in('id', profileIds),
      summariseCollections(db, profileIds),
      rosterReadiness(db, profileIds),
      db.from('league_fixtures')
        .select(`id, day_index, stage, bracket_key, blue_member_id, red_member_id, scheduled_at,
                 status, duel_id, winner_member_id, winner_side, game_length, blue_kills, red_kills`)
        .eq('league_id', league.id)
        // This season's calendar. Earlier seasons are still there — nothing is deleted
        // at a reset (migration 0014) — but the table, the bracket and "tonight" are all
        // questions about the season being played.
        .eq('season', league.season ?? 1)
        .order('day_index', { ascending: true }),
      /**
       * Friendlies in flight with the people in this league, so the button on each
       * row can say what it actually does — send one, or walk back into the room.
       */
      db.from('duels')
        .select('id, status, challenger_id, opponent_id')
        .or(`challenger_id.eq.${profileId},opponent_id.eq.${profileId}`)
        .in('status', ['PENDING', 'DRAFTING', 'WATCHING']),
    ]);

  const byId = new Map((profiles || []).map((p: any) => [p.id, p]));

  const liveWith = new Map<string, { id: string; status: string; mine: boolean }>();
  for (const d of (duels || []) as any[]) {
    const otherId = d.challenger_id === profileId ? d.opponent_id : d.challenger_id;
    if (!otherId || liveWith.has(otherId)) continue;
    liveWith.set(otherId, { id: d.id, status: d.status, mine: d.challenger_id === profileId });
  }

  const shapedMembers = members.map((m) => {
    const p = byId.get(m.profile_id);
    const filled = readiness.get(m.profile_id) ?? 0;
    const duel = liveWith.get(m.profile_id) ?? null;

    return {
      id: m.id,
      profileId: m.profile_id,
      teamName: m.team_name,
      handle: p?.handle ?? null,
      displayName: p?.display_name ?? p?.handle ?? 'Manager',
      isOwner: m.is_owner,
      isMe: m.profile_id === profileId,
      joinedAt: m.joined_at,
      /** Out of five. Below five, this manager cannot be challenged yet. */
      rosterFilled: filled,
      rosterSlots: ROLES.length,
      ready: filled === ROLES.length,
      collection: summaries.get(m.profile_id) ?? { total: 0, bands: {}, best: null },
      /** A friendly already in flight between us, if there is one. */
      duel: duel && m.profile_id !== profileId
        ? { id: duel.id, status: duel.status, iChallenged: duel.mine }
        : null,
    };
  });

  const byMemberId = new Map(members.map((m) => [m.id, m]));
  const name = (memberId: string | null) =>
    (memberId ? byMemberId.get(memberId)?.team_name ?? 'Unknown' : 'Ghost');

  const rows = (fixtures || []) as any[];

  /**
   * The bracket, if this league has one (migration 0013, shared/playoffs.ts).
   *
   * Rebuilt from the playoff rows rather than recomputed from the table, so the screen
   * shows the bracket that was actually drawn. Null for a league that has not reached its
   * playoffs, which is most of them for most of a season.
   */
  const bracket = rows.some((f) => f.bracket_key)
    ? loadBracket(league.id, members, rows)
    : null;

  const bracketMatch = (key: string | null) =>
    (key ? bracket?.bracket.matches.find((m) => m.key === key) ?? null : null);

  /**
   * What to call a side of a playoff fixture that has not been decided yet.
   *
   * A grand final exists as a row, with a date, from the moment the bracket is drawn —
   * that is what the bracket is for — so for a day or two one or both of its sides is a
   * sentence rather than a team. "Winner of the semi-final" is the honest version of it,
   * and it is what makes the fixture readable on the calendar before it is playable.
   */
  const semiCount = bracket?.bracket.matches.filter((m) => m.stage === 'SEMI').length ?? 0;

  /**
   * A three-manager bracket has one semi, so numbering it reads as though a second one went
   * missing. Four have two, and then they need telling apart.
   */
  const semiName = (key: string) => (
    semiCount < 2 ? 'the semi-final'
      : key === 'SF2' ? 'the second semi-final'
        : 'the first semi-final'
  );

  const winnerOf = (key: string | null | undefined) =>
    (key ? `Winner of ${semiName(key)}` : 'To be decided');

  const sideOf = (f: any, side: 'BLUE' | 'RED') => {
    const memberId = side === 'BLUE' ? f.blue_member_id : f.red_member_id;
    if (memberId) return { memberId, teamName: name(memberId), pending: false };

    if (!isPlayoffStage(f.stage)) return null;

    const match = bracketMatch(f.bracket_key);
    const from = side === 'BLUE' ? match?.blueFrom : match?.redFrom;

    return {
      memberId: null,
      teamName: winnerOf(from),
      pending: true,
    };
  };

  /**
   * The schedule, grouped by day. A preview when the season has not been generated,
   * which is the same shape with no ids — so the screen draws one calendar either way.
   */
  const preview = rows.length === 0;
  const source = rows.length
    ? rows
    : (members.length >= 2
        ? buildFixtures(league, members).map((f, i) => ({
            id: `preview-${i}`,
            day_index: f.day_index,
            stage: f.stage,
            bracket_key: null,
            blue_member_id: f.blue_member_id,
            red_member_id: f.red_member_id,
            scheduled_at: f.scheduled_at,
            status: 'SCHEDULED',
            duel_id: null,
            winner_member_id: null,
            winner_side: null,
            game_length: null,
            blue_kills: null,
            red_kills: null,
          }))
        : []);

  const days = new Map<number, any>();
  for (const f of source) {
    const day = days.get(f.day_index) || {
      dayIndex: f.day_index,
      rest: false,
      scheduledAt: f.scheduled_at,
      fixtures: [] as any[],
    };

    if (f.stage === 'REST') {
      day.rest = true;
    } else {
      const mineSide = f.blue_member_id === me.id ? 'BLUE'
        : f.red_member_id === me.id ? 'RED' : null;

      const window = fixtureWindow(f.scheduled_at);
      const final = f.status === 'FINAL';

      const blueSide = sideOf(f, 'BLUE');
      const redSide = sideOf(f, 'RED');
      /** A playoff fixture still waiting on a semi cannot be opened (openFixture says so). */
      const pending = Boolean(blueSide?.pending || redSide?.pending);

      day.fixtures.push({
        id: f.id,
        stage: f.stage,
        /** 'SF1' | 'SF2' | 'FINAL' on a playoff row, so the screen can label it. */
        bracketKey: f.bracket_key ?? null,
        playoff: isPlayoffStage(f.stage),
        status: f.status,
        scheduledAt: f.scheduled_at,
        blue: blueSide ?? { memberId: null, teamName: 'Ghost', pending: false },
        red: redSide,
        pending,
        duelId: f.duel_id,
        mine: mineSide !== null,
        side: mineSide,
        opponent: mineSide === 'BLUE'
          ? (redSide ? redSide.teamName : 'A Ghost')
          : mineSide === 'RED' ? blueSide?.teamName ?? 'Unknown' : null,

        /** Null until the match has been decided. */
        result: final
          ? {
              winnerSide: f.winner_side,
              winnerMemberId: f.winner_member_id,
              winnerTeamName: f.winner_member_id ? name(f.winner_member_id) : 'The Ghost',
              iWon: mineSide ? f.winner_side === mineSide : null,
              gameLength: f.game_length,
              blueKills: f.blue_kills,
              redKills: f.red_kills,
            }
          : null,

        /**
         * Whether the button is live. A fixture of mine, not yet decided, with its
         * lobby open — and not a preview, which has no row to open.
         */
        playable: Boolean(mineSide) && !final && !preview && !pending && window.open,
        opensAt: window.opensAt ? new Date(window.opensAt).toISOString() : null,
        secondsUntilOpen: window.secondsUntil,
      });
    }

    day.scheduledAt = day.scheduledAt || f.scheduled_at;
    days.set(f.day_index, day);
  }

  const schedule = [...days.values()].sort((a, b) => a.dayIndex - b.dayIndex);

  /**
   * The fixture of mine that still wants something from me.
   *
   * Earliest undecided one, past kick-off included. A league of friends misses an
   * evening, and the fixture they missed is still the next thing to play — pointing
   * them at tomorrow's instead would quietly skip it.
   */
  const mineOpen = schedule
    .flatMap((d) => d.fixtures.map((f: any) => ({ ...f, dayIndex: d.dayIndex })))
    .filter((f: any) => f.mine && !f.result && f.scheduledAt)
    .sort((a: any, b: any) => a.scheduledAt.localeCompare(b.scheduledAt));

  /** My last decided fixture, which is what "how did it go" means on this screen. */
  const minePlayed = schedule
    .flatMap((d) => d.fixtures.map((f: any) => ({ ...f, dayIndex: d.dayIndex })))
    .filter((f: any) => f.mine && f.result)
    .sort((a: any, b: any) => b.scheduledAt.localeCompare(a.scheduledAt));

  const table = preview
    ? []
    : standings(
        members.map((m) => m.id),
        rows.map((f) => ({
          stage: f.stage,
          status: f.status,
          blueMemberId: f.blue_member_id,
          redMemberId: f.red_member_id,
          winnerMemberId: f.winner_member_id,
          gameLength: f.game_length,
          blueKills: f.blue_kills,
          redKills: f.red_kills,
        })),
        league.id,
      ).map((row) => ({
        ...row,
        teamName: byMemberId.get(row.memberId)?.team_name ?? 'Unknown',
        isMe: row.memberId === me.id,
      }));

  /**
   * The bracket, as the screen draws it: three matches (or two, or one), each with its two
   * sides and its result. docs/01 section 3's shape, and the degenerate ones a league of two
   * or three gets — see shared/playoffs.ts.
   *
   * Built from the bracket rather than from the calendar so the final is a slot with a name
   * even while its sides are two unfinished semis. The fixtures are still in `schedule`;
   * this is the same rows read as a bracket instead of as evenings.
   */
  const fixtureByKey = new Map(rows.filter((f) => f.bracket_key).map((f) => [f.bracket_key, f]));

  const payouts = league.status === 'FINISHED'
    ? await seasonPayouts(db, league.id, league.season ?? 1)
    : new Map();

  /**
   * Every season this league has finished, most recent first (migration 0014).
   *
   * Read always, not only once the current season is over: a league on season 2 should be
   * able to see who won season 1 on an ordinary Tuesday, which is the whole reason the
   * record outlives `leagues.champion_member_id`.
   */
  const pastSeasons = (league.season ?? 1) > 1 || league.status === 'FINISHED'
    ? await honoursOf(db, league.id)
    : [];

  const playoffs = bracket
    ? {
        /** Member ids, best seed first. Seed n is `seeds[n - 1]`. */
        seeds: bracket.bracket.seeds.map((memberId, i) => ({
          seed: i + 1,
          memberId,
          teamName: name(memberId),
          isMe: memberId === me.id,
        })),
        missed: bracket.bracket.missed.map((memberId) => ({
          memberId, teamName: name(memberId), isMe: memberId === me.id,
        })),
        matches: bracket.bracket.matches.map((m) => {
          const f = fixtureByKey.get(m.key);
          const sides = bracket.state.sides[m.key];
          const label = m.stage === 'GRAND_FINAL'
            ? 'Final'
            : semiCount < 2 ? 'Semi-final'
              : m.key === 'SF2' ? 'Semi-final 2' : 'Semi-final 1';

          return {
            key: m.key,
            stage: m.stage,
            label,
            fixtureId: f?.id ?? null,
            dayIndex: f?.day_index ?? null,
            scheduledAt: f?.scheduled_at ?? null,
            duelId: f?.duel_id ?? null,
            status: f?.status ?? 'SCHEDULED',
            blue: sides?.blue
              ? { memberId: sides.blue, teamName: name(sides.blue), isMe: sides.blue === me.id }
              : null,
            red: sides?.red
              ? { memberId: sides.red, teamName: name(sides.red), isMe: sides.red === me.id }
              : null,
            /** What to call a side that is still an unplayed semi-final. */
            blueLabel: winnerOf(m.blueFrom),
            redLabel: winnerOf(m.redFrom),
            winnerMemberId: f?.status === 'FINAL' ? f.winner_member_id ?? null : null,
            mine: [sides?.blue, sides?.red].includes(me.id),
          };
        }),
        decided: bracket.state.decided,
        championMemberId: bracket.state.championMemberId,
        runnerUpMemberId: bracket.state.runnerUpMemberId,
      }
    : null;

  /**
   * The honours board. Only once the season is finished, because before that every number
   * in it would be a guess at a bracket that is still being played.
   */
  const honours = league.status === 'FINISHED' && playoffs?.decided
    ? [...payouts.entries()]
        .map(([memberId, row]: [string, any]) => ({
          memberId,
          teamName: name(memberId),
          isMe: memberId === me.id,
          placing: row.placing,
          credits: row.credits,
          label: row.label,
        }))
        .sort((a, b) => a.placing - b.placing)
    : [];

  return {
    league: {
      ...shapeLeague(league, members, profileId),
      championTeamName: league.champion_member_id ? name(league.champion_member_id) : null,
    },
    me: { memberId: me.id, profileId, teamName: me.team_name },
    members: shapedMembers,
    /** True when `schedule` is what a launch would write rather than what it wrote. */
    schedulePreview: preview,
    schedule,
    standings: table,
    next: mineOpen[0] ?? null,
    last: minePlayed[0] ?? null,
    playoffs,
    honours,
    /**
     * The honours board. One entry per finished season, newest first — including the one
     * that has just finished, so a FINISHED league shows its own trophy here too.
     */
    pastSeasons: pastSeasons.map((row) => ({
      season: row.season,
      startsOn: row.starts_on,
      finishedAt: row.finished_at,
      days: row.days,
      matchDays: row.match_days,
      championMemberId: row.champion_member_id,
      championTeamName: row.champion_member_id ? name(row.champion_member_id) : null,
      iWon: Boolean(row.champion_member_id) && row.champion_member_id === me.id,
      /** True for the season currently on this screen. */
      current: row.season === (league.season ?? 1),
    })),
    /** What the champion's 1500 is, so the screen never hard-codes a number. */
    championCredits: seasonPlacingCredits(1),
    canLaunch: league.owner_id === profileId
      && league.status === 'FORMING'
      && members.length >= 2,
    /**
     * The owner's repair button (server/api/league/[id]/playoffs.post.ts). Offered only when
     * there is genuinely something for it to do, which is the difference between a repair
     * path and a second way of doing it.
     *
     * Three cases, all of them states the automatic hook should have left behind and did
     * not: a finished regular season with no bracket; a bracket whose next match has both
     * sides decided but whose row does not know them yet; a decided bracket on a league
     * still marked ACTIVE, which means the final was played and the season never settled.
     *
     * Note the second one compares the *stored* row against the computed state, not the
     * state against itself — `playoffs.matches[].blue` is what the bracket says should be
     * there, so comparing it to itself would hide exactly the failure this button repairs.
     */
    /**
     * Whether the owner can start another season (docs/01 section 7 point 4). A finished
     * league with enough managers still in it; the route re-checks both.
     */
    canStartNextSeason: league.owner_id === profileId
      && league.status === 'FINISHED'
      && members.length >= 2,
    nextSeason: (league.season ?? 1) + 1,
    canDrawPlayoffs: league.owner_id === profileId
      && league.status === 'ACTIVE'
      && !preview
      && rows.some((f) => f.stage === 'REGULAR')
      && rows.every((f) => f.stage !== 'REGULAR' || f.status === 'FINAL' || f.status === 'VOID')
      && (
        !playoffs
        || playoffs.decided
        || playoffs.matches.some((m) => {
          const f = fixtureByKey.get(m.key);
          if (!f || f.status === 'FINAL') return false;
          return Boolean(m.blue && m.red) && !(f.blue_member_id && f.red_member_id);
        })
      ),
  };
});
