import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { summariseCollections } from '~~/server/utils/discovery';
import {
  requireMembership, shapeLeague, rosterReadiness, buildFixtures,
} from '~~/server/utils/league';
import { fixtureWindow } from '~~/shared/league';
import { standings } from '~~/shared/standings';
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
        .select(`id, day_index, stage, blue_member_id, red_member_id, scheduled_at, status,
                 duel_id, winner_member_id, winner_side, game_length, blue_kills, red_kills`)
        .eq('league_id', league.id)
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

      day.fixtures.push({
        id: f.id,
        stage: f.stage,
        status: f.status,
        scheduledAt: f.scheduled_at,
        blue: { memberId: f.blue_member_id, teamName: name(f.blue_member_id) },
        red: f.red_member_id
          ? { memberId: f.red_member_id, teamName: name(f.red_member_id) }
          : null,
        duelId: f.duel_id,
        mine: mineSide !== null,
        side: mineSide,
        opponent: mineSide === 'BLUE'
          ? (f.red_member_id ? name(f.red_member_id) : 'A Ghost')
          : mineSide === 'RED' ? name(f.blue_member_id) : null,

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
        playable: Boolean(mineSide) && !final && !preview && window.open,
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

  return {
    league: shapeLeague(league, members, profileId),
    me: { memberId: me.id, profileId, teamName: me.team_name },
    members: shapedMembers,
    /** True when `schedule` is what a launch would write rather than what it wrote. */
    schedulePreview: preview,
    schedule,
    standings: table,
    next: mineOpen[0] ?? null,
    last: minePlayed[0] ?? null,
    canLaunch: league.owner_id === profileId
      && league.status === 'FORMING'
      && members.length >= 2,
  };
});
