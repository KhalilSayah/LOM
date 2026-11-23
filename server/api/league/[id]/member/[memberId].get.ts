import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { requireMembership, rosterReadiness, draftedSides } from '~~/server/utils/league';
import {
  standings, formOf, headToHead, resultsFor, upsetIds, type ResultFixture,
} from '~~/shared/standings';
import { ROLES } from '~~/shared/roster';

/**
 * A leaguemate, as an opponent sees them: their season, not their cards.
 *
 * This used to return their whole collection and the exact five they field. docs/01
 * section 4 and docs/05 section 2 both say otherwise — the rest of a collection is never
 * visible to an opponent (a v2 scouting feature), and the starting five is revealed at
 * draft start, not the evening before, because knowing it in advance is the whole of
 * banning. What a league does earn you is their record: where they sit, how they are
 * playing, how they do against you, and their last few results.
 *
 * Whether their five is complete is still here, as a count, because "can I send them a
 * friendly" is a question this screen has to answer.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const id = getRouterParam(event, 'id');
  const memberId = getRouterParam(event, 'memberId');
  if (!id || !memberId) throw createError({ statusCode: 400, statusMessage: 'Which manager?' });

  const { league, members, me } = await requireMembership(db, id, profileId);
  const member = members.find((m) => m.id === memberId);
  if (!member) throw createError({ statusCode: 404, statusMessage: 'Nobody by that name in this league.' });

  const [{ data: profile }, readiness, { data: fixtures, error }] = await Promise.all([
    db.from('profiles').select('handle, display_name').eq('id', member.profile_id).maybeSingle(),
    rosterReadiness(db, [member.profile_id]),
    db.from('league_fixtures')
      .select(`id, day_index, stage, blue_member_id, red_member_id, ghost_side, scheduled_at,
               status, duel_id, winner_member_id, winner_side, game_length, blue_kills, red_kills,
               played_at, auto_played_at`)
      .eq('league_id', league.id)
      .eq('season', league.season ?? 1),
  ]);

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  const rows = (fixtures || []) as any[];
  const byFixture = new Map(rows.map((f) => [f.id, f]));
  const name = new Map(members.map((m) => [m.id, m.team_name]));

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

  const table = standings(
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
  );
  const row = table.find((r) => r.memberId === member.id);
  const upsets = upsetIds(results);
  const isMe = member.id === me.id;

  const recent = resultsFor(member.id, results).slice(0, 3).map((r) => {
    const f = byFixture.get(r.fixture.id);
    const iPlayed = r.opponentId === me.id || isMe;
    return {
      fixtureId: r.fixture.id,
      dayIndex: f?.day_index ?? null,
      stage: r.fixture.stage,
      won: r.won,
      opponent: r.opponentId ? name.get(r.opponentId) ?? 'Unknown' : 'A Ghost',
      opponentId: r.opponentId,
      kills: r.side === 'BLUE'
        ? { mine: f?.blue_kills ?? 0, theirs: f?.red_kills ?? 0 }
        : { mine: f?.red_kills ?? 0, theirs: f?.blue_kills ?? 0 },
      gameLength: f?.game_length ?? null,
      playedAt: r.fixture.playedAt || r.fixture.scheduledAt,
      upset: upsets.has(r.fixture.id),
      autoPlayed: Boolean(f?.auto_played_at),
      /**
       * The replay is the duel room's, and only its two managers can open it
       * (server/api/duel/[id].get.ts), so the link is offered only to them.
       */
      duelId: iPlayed ? f?.duel_id ?? null : null,
    };
  });

  return {
    league: {
      id: league.id,
      name: league.name,
      status: league.status,
      season: league.season ?? 1,
    },
    member: {
      id: member.id,
      profileId: member.profile_id,
      teamName: member.team_name,
      isOwner: member.is_owner,
      isMe,
      handle: profile?.handle ?? null,
      displayName: profile?.display_name ?? profile?.handle ?? 'Manager',
      joinedAt: member.joined_at,
    },
    record: row
      ? {
          position: row.position,
          of: table.length,
          played: row.played,
          won: row.won,
          lost: row.lost,
          points: row.points,
        }
      : null,
    form: formOf(member.id, results),
    /** From their side: how they have done against you. Null on your own page. */
    headToHead: isMe ? null : headToHead(member.id, me.id, results),
    recent,
    rosterFilled: readiness.get(member.profile_id) ?? 0,
    rosterSlots: ROLES.length,
  };
});
