import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import {
  requireMembership, shapeLeague, rosterReadiness, buildFixtures, draftedSides,
} from '~~/server/utils/league';
import { catchUpLeague } from '~~/server/utils/leagueFixture';
import { fixtureWindow } from '~~/shared/league';
import {
  standings, formOf, resultsFor, upsetIds, type ResultFixture,
} from '~~/shared/standings';
import { loadBracket, isPlayoffStage } from '~~/server/utils/leaguePlayoffs';
import { seasonPayouts } from '~~/server/utils/seasonRewards';
import { honoursOf } from '~~/server/utils/leagueSeason';
import { seasonPlacingCredits } from '~~/shared/rewards';
import { ROLES } from '~~/shared/roster';

/**
 * Everything the league screen draws, in one response.
 *
 * One round trip on purpose: the screen is a table of people and a calendar, and
 * both are small. Fetching the members, then their results, then the schedule
 * would give a screen that assembles itself in three visible steps every time
 * somebody opens it to check who they play tonight.
 *
 * While a league is FORMING there are no fixtures yet, so the schedule comes back as
 * a *preview* built by the same function the launch will use. The owner is about to
 * commit five other people to a fortnight of evenings; they should see the shape of
 * it first, and see it change as people join.
 *
 * Reading a league also brings it up to date (catchUpLeague): a result whose write
 * failed is recorded, and a fixture nobody opened within a day of kick-off is played by
 * the agent — so the table this returns is never waiting on somebody who is not coming.
 *
 * What it does not return any more is anybody's collection. docs/01 section 4 and
 * docs/05 section 2: the rest of a manager's collection is never visible to an
 * opponent. A leaguemate is their record, their form and their results.
 */

const FIXTURE_FIELDS = `
  id, day_index, stage, bracket_key, blue_member_id, red_member_id, ghost_side, scheduled_at,
  status, duel_id, winner_member_id, winner_side, game_length, blue_kills, red_kills,
  played_at, created_at, stand_ins, auto_played_at, blue_ready_at, red_ready_at
`;

/** How many lines of activity the screen shows. A feed, not an archive. */
const FEED_LENGTH = 14;

export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Which league?' });

  let { league, members, me } = await requireMembership(db, id, profileId);

  // Catch up first, so everything below reads the league as it now stands. A change can
  // include the season ending, so the league row is read again rather than patched.
  if (await catchUpLeague(db, league, members)) {
    ({ league, members, me } = await requireMembership(db, id, profileId));
  }

  const profileIds = members.map((m) => m.profile_id);
  const now = Date.now();

  const [{ data: profiles }, readiness, { data: fixtures }, { data: duels }] =
    await Promise.all([
      db.from('profiles').select('id, handle, display_name').in('id', profileIds),
      rosterReadiness(db, profileIds),
      db.from('league_fixtures')
        .select(FIXTURE_FIELDS)
        .eq('league_id', league.id)
        // This season's calendar. Earlier seasons are still there — nothing is deleted
        // at a reset (migration 0014) — but the table, the bracket and "tonight" are all
        // questions about the season being played.
        .eq('season', league.season ?? 1)
        .order('day_index', { ascending: true }),
      /**
       * Friendlies in flight with the people in this league, so the button on each
       * row can say what it actually does — send one, accept one, or walk back into the
       * room. Friendlies only: a fixture's room is a duel between the same two people,
       * and without the filter a manager row offered "Rejoin" for tonight's fixture.
       */
      db.from('duels')
        .select('id, status, challenger_id, opponent_id')
        .eq('source', 'CHALLENGE')
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

  const byMemberId = new Map(members.map((m) => [m.id, m]));
  const name = (memberId: string | null) =>
    (memberId ? byMemberId.get(memberId)?.team_name ?? 'Unknown' : 'Ghost');

  const rows = (fixtures || []) as any[];

  /** Every decided fixture, sides as drafted — what form, head-to-head and upsets read. */
  const results: ResultFixture[] = rows.map((f) => {
    const sides = draftedSides(f);
    return {
      id: f.id,
      stage: f.stage,
      status: f.status,
      blueMemberId: sides.blue,
      redMemberId: sides.red,
      winnerMemberId: f.winner_member_id,
      winnerSide: f.winner_side,
      playedAt: f.played_at,
      scheduledAt: f.scheduled_at,
    };
  });
  const upsets = upsetIds(results);

  const preview = rows.length === 0;

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
        form: formOf(row.memberId, results),
      }));

  const tableRow = new Map(table.map((r) => [r.memberId, r]));

  const shapedMembers = members.map((m) => {
    const p = byId.get(m.profile_id);
    const filled = readiness.get(m.profile_id) ?? 0;
    const duel = liveWith.get(m.profile_id) ?? null;
    const standing = tableRow.get(m.id);

    return {
      id: m.id,
      profileId: m.profile_id,
      teamName: m.team_name,
      handle: p?.handle ?? null,
      displayName: p?.display_name ?? p?.handle ?? 'Manager',
      isOwner: m.is_owner,
      isMe: m.profile_id === profileId,
      joinedAt: m.joined_at,
      /** Out of five. Below five, stand-ins fill the gap in a fixture; a friendly needs five. */
      rosterFilled: filled,
      rosterSlots: ROLES.length,
      ready: filled === ROLES.length,
      /** This season's regular-season record, and the last five results, oldest first. */
      record: standing
        ? { won: standing.won, lost: standing.lost, points: standing.points, position: standing.position }
        : null,
      form: formOf(m.id, results),
      /** A friendly already in flight between us, if there is one. */
      duel: duel && m.profile_id !== profileId
        ? { id: duel.id, status: duel.status, iChallenged: duel.mine }
        : null,
    };
  });

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

  /** One drafted side of a fixture, as the screen labels it. Null is the Ghost. */
  const sideOf = (f: any, side: 'BLUE' | 'RED') => {
    const drafted = draftedSides(f);
    const memberId = side === 'BLUE' ? drafted.blue : drafted.red;
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
            ghost_side: f.ghost_side ?? null,
            scheduled_at: f.scheduled_at,
            status: 'SCHEDULED',
            duel_id: null,
            winner_member_id: null,
            winner_side: null,
            game_length: null,
            blue_kills: null,
            red_kills: null,
            played_at: null,
            stand_ins: null,
            auto_played_at: null,
            blue_ready_at: null,
            red_ready_at: null,
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
      const blueSide = sideOf(f, 'BLUE');
      const redSide = sideOf(f, 'RED');
      const mineSide = blueSide?.memberId === me.id ? 'BLUE'
        : redSide?.memberId === me.id ? 'RED' : null;

      const window = fixtureWindow(f.scheduled_at, now);
      const final = f.status === 'FINAL';
      /** A playoff fixture still waiting on a semi cannot be opened (openFixture says so). */
      const pending = Boolean(blueSide?.pending || redSide?.pending);

      const ghostSide = f.stage === 'GHOST' ? (f.ghost_side === 'BLUE' ? 'BLUE' : 'RED') : null;
      const readyOf = (side: 'BLUE' | 'RED') =>
        ghostSide === side || Boolean(side === 'BLUE' ? f.blue_ready_at : f.red_ready_at);

      /**
       * Where the evening is: not yet, the lobby (open, draft held to kick-off), live
       * (kick-off has passed, the room can still be opened), or overdue (a day late,
       * the agent plays it on the next read). The screen words each one differently.
       */
      const phase = final ? 'DONE'
        : !window.open ? 'SOON'
          : !window.started ? 'LOBBY'
            : window.overdue ? 'OVERDUE'
              : 'LIVE';

      const standIns = (f.stand_ins || {}) as Record<string, string[]>;

      day.fixtures.push({
        id: f.id,
        stage: f.stage,
        /** 'SF1' | 'SF2' | 'FINAL' on a playoff row, so the screen can label it. */
        bracketKey: f.bracket_key ?? null,
        playoff: isPlayoffStage(f.stage),
        status: f.status,
        scheduledAt: f.scheduled_at,
        /** Drafted sides: a Ghost on blue is `blue: null`, not the manager. */
        blue: blueSide ?? { memberId: null, teamName: 'Ghost', pending: false },
        red: redSide ?? { memberId: null, teamName: 'Ghost', pending: false },
        ghostSide,
        pending,
        duelId: f.duel_id,
        mine: mineSide !== null,
        side: mineSide,
        opponent: mineSide === 'BLUE'
          ? (redSide ? redSide.teamName : 'A Ghost')
          : mineSide === 'RED' ? (blueSide ? blueSide.teamName : 'A Ghost') : null,

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
              upset: upsets.has(f.id),
            }
          : null,

        /** Slots fielded with a catalogue stand-in, per drafted side (migration 0016). */
        standIns: { BLUE: standIns.BLUE ?? [], RED: standIns.RED ?? [] },
        autoPlayed: Boolean(f.auto_played_at),
        ready: { BLUE: readyOf('BLUE'), RED: readyOf('RED') },
        phase,

        /**
         * Whether the button is live. A fixture of mine, not yet decided, with its
         * lobby open — and not a preview, which has no row to open.
         */
        playable: Boolean(mineSide) && !final && !preview && !pending && window.open,
        /**
         * Only the two managers can open a fixture's replay: the duel room is theirs
         * (server/api/duel/[id].get.ts). The calendar links it for them and only them.
         */
        canWatch: Boolean(mineSide) && Boolean(f.duel_id),
        opensAt: window.opensAt ? new Date(window.opensAt).toISOString() : null,
        autoPlayAt: window.autoPlayAt ? new Date(window.autoPlayAt).toISOString() : null,
        secondsUntilOpen: window.secondsUntil,
      });
    }

    day.scheduledAt = day.scheduledAt || f.scheduled_at;
    days.set(f.day_index, day);
  }

  const schedule = [...days.values()].sort((a, b) => a.dayIndex - b.dayIndex);
  const allFixtures = schedule.flatMap((d) => d.fixtures.map((f: any) => ({ ...f, dayIndex: d.dayIndex })));

  /**
   * The fixture of mine that still wants something from me.
   *
   * Earliest undecided one, past kick-off included. A league of friends misses an
   * evening, and the fixture they missed is still the next thing to play — pointing
   * them at tomorrow's instead would quietly skip it. Except a Ghost a day overdue:
   * nobody has to play a bye, and one skipped should not sit at the top for ever.
   */
  const mineOpen = allFixtures
    .filter((f: any) => f.mine && !f.result && f.scheduledAt && !f.pending)
    .filter((f: any) => !(f.stage === 'GHOST' && f.phase === 'OVERDUE' && !f.duelId))
    .sort((a: any, b: any) => a.scheduledAt.localeCompare(b.scheduledAt));

  /** My last decided fixture, which is what "how did it go" means on this screen. */
  const minePlayed = allFixtures
    .filter((f: any) => f.mine && f.result)
    .sort((a: any, b: any) => b.scheduledAt.localeCompare(a.scheduledAt));

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
          const mine = [sides?.blue, sides?.red].includes(me.id);

          return {
            key: m.key,
            stage: m.stage,
            label,
            fixtureId: f?.id ?? null,
            dayIndex: f?.day_index ?? null,
            scheduledAt: f?.scheduled_at ?? null,
            duelId: mine ? f?.duel_id ?? null : null,
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
            upset: f ? upsets.has(f.id) : false,
            mine,
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

  /**
   * The activity feed: what happened in this league lately, newest first.
   *
   * Derived, not stored. Every line is already a row somewhere — a membership's
   * `joined_at`, a fixture's `played_at`, the bracket rows' `created_at`, the league's
   * `started_at` and `finished_at` — so a feed table would be a second record of the same
   * facts, waiting to disagree with the first. Ghost results are left out: they are a
   * daily line in an odd league that says nothing about anybody else.
   */
  const feed: any[] = [];

  for (const m of members) {
    feed.push({
      id: `join-${m.id}`, kind: 'JOIN', at: m.joined_at,
      text: m.is_owner ? `${m.team_name} set up the league` : `${m.team_name} joined`,
      isMe: m.id === me.id,
    });
  }

  if (league.started_at) {
    feed.push({
      id: `season-${league.season ?? 1}`, kind: 'SEASON', at: league.started_at,
      text: (league.season ?? 1) > 1 ? `Season ${league.season} started` : 'The season started',
    });
  }

  for (const r of results) {
    if (r.status !== 'FINAL' || !r.winnerSide || !r.blueMemberId || !r.redMemberId) continue;
    const row = rows.find((f) => f.id === r.id);
    const winner = r.winnerSide === 'BLUE' ? r.blueMemberId : r.redMemberId;
    const loser = r.winnerSide === 'BLUE' ? r.redMemberId : r.blueMemberId;
    const stage = r.stage === 'SEMI' ? ' in the semi-final' : r.stage === 'GRAND_FINAL' ? ' in the final' : '';
    const mine = winner === me.id || loser === me.id;

    feed.push({
      id: `result-${r.id}`, kind: 'RESULT', at: r.playedAt || r.scheduledAt,
      text: `${name(winner)} beat ${name(loser)}${stage}`,
      upset: upsets.has(r.id),
      autoPlayed: Boolean(row?.auto_played_at),
      gameLength: row?.game_length ?? null,
      duelId: mine ? row?.duel_id ?? null : null,
      isMe: mine,
    });
  }

  const bracketRows = rows.filter((f) => f.bracket_key);
  if (bracketRows.length) {
    const drawnAt = bracketRows.map((f) => f.created_at).filter(Boolean).sort()[0];
    if (drawnAt) {
      const seeds = playoffs?.seeds.length ?? 0;
      feed.push({
        id: 'bracket', kind: 'BRACKET', at: drawnAt,
        text: seeds >= 4 ? 'The regular season ended. The top four go to the playoffs'
          : seeds === 3 ? 'The regular season ended. The top seed byes to the final'
            : 'The regular season ended. First plays second in the final',
      });
    }
  }

  if (league.status === 'FINISHED' && league.champion_member_id && league.finished_at) {
    feed.push({
      id: `champion-${league.season ?? 1}`, kind: 'CHAMPION', at: league.finished_at,
      text: `${name(league.champion_member_id)} won season ${league.season ?? 1}`,
      isMe: league.champion_member_id === me.id,
    });
  }

  feed.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

  const isOwner = league.owner_id === profileId;

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
    /** My last three results against leaguemates, newest first, for "how is it going". */
    myResults: resultsFor(me.id, results).slice(0, 3).map((r) => r.fixture.id),
    playoffs,
    honours,
    feed: feed.slice(0, FEED_LENGTH),
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
    canLaunch: isOwner
      && league.status === 'FORMING'
      && members.length >= 2,
    /**
     * The owner's settings while the league forms: hour, timezone, name, the invite code
     * and who is in. All of them lock at Start season (the routes re-check).
     */
    canEditSettings: isOwner && league.status === 'FORMING',
    /**
     * Whether the owner can start another season (docs/01 section 7 point 4). A finished
     * league with enough managers still in it; the route re-checks both.
     */
    canStartNextSeason: isOwner
      && league.status === 'FINISHED'
      && members.length >= 2,
    nextSeason: (league.season ?? 1) + 1,
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
    canDrawPlayoffs: isOwner
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
    serverNow: new Date(now).toISOString(),
  };
});
