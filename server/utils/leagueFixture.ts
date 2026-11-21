import type { SupabaseClient } from '@supabase/supabase-js';
import { snapshotLineup, lineupComplete } from './duel';
import { botLineup } from './duelBot';
import { ACTION_SECONDS, BONUS_SECONDS } from '~~/shared/draft';
import { LOBBY_SECONDS, WATCH_SPEED } from '~~/shared/duelRoom';
import { fixtureWindow } from '~~/shared/league';
import { afterFixtureFinal, isPlayoffStage } from './leaguePlayoffs';
import type { LeagueRow, MemberRow } from './league';

/**
 * Playing a fixture.
 *
 * A league fixture is played in the duel room — the same twenty actions, the same
 * clock, the same engine (docs/05 section 0 planned it the other way round: the duel
 * was built first precisely so that a fixture could become "another thing that can
 * open a duel"). So there is no second draft implementation here. What this module
 * does is the two joins that make a duel a fixture:
 *
 *   opening   — build the duel with the sides the schedule already decided
 *   recording — copy the decided result onto the fixture, for the table
 *
 * Sides are the one real difference from a friendly. A friendly draws them at accept,
 * because otherwise challenging somebody would be worth first pick. A fixture does
 * not draw anything: the schedule assigned them weeks ago, and swapped them for the
 * second cycle, so that over a season everybody drafts first about as often.
 */

export interface FixtureRow {
  id: string;
  league_id: string;
  day_index: number;
  stage: 'REGULAR' | 'GHOST' | 'REST' | 'SEMI' | 'GRAND_FINAL';
  /** 'SF1' | 'SF2' | 'FINAL' on a playoff row, null on everything else (migration 0013). */
  bracket_key?: string | null;
  blue_member_id: string | null;
  red_member_id: string | null;
  scheduled_at: string | null;
  status: string;
  duel_id: string | null;
}

/**
 * Open the room for a fixture, or hand back the one that is already open.
 *
 * Idempotent on purpose, and that is the whole reliability story: both managers tap
 * the same button within a second of each other, and whichever request lands second
 * finds `duel_id` already set — or loses the race on the unique index and reads it
 * back. Nobody ever gets a second room for the same fixture.
 */
export async function openFixture(
  db: SupabaseClient,
  league: LeagueRow,
  fixture: FixtureRow,
  members: MemberRow[],
  profileId: string,
): Promise<{ duelId: string; opened: boolean }> {
  if (fixture.duel_id) return { duelId: fixture.duel_id, opened: false };

  if (fixture.stage === 'REST') {
    throw createError({ statusCode: 400, statusMessage: 'That is a rest day.' });
  }
  if (fixture.status === 'VOID') {
    throw createError({ statusCode: 409, statusMessage: 'That fixture was voided.' });
  }

  /**
   * A playoff fixture whose sides are not both known yet.
   *
   * The final exists as a row from the moment the bracket is drawn, with a date on it, and
   * fills its sides in as the semis resolve (migration 0013 relaxed the sides constraint for
   * exactly that). So it has to be refused here, and refused *before* the Ghost branch
   * below — which would otherwise read the pending red side as "no opponent" and hand the
   * grand final to the auto-draft agent.
   */
  if (isPlayoffStage(fixture.stage) && !(fixture.blue_member_id && fixture.red_member_id)) {
    throw createError({
      statusCode: 409,
      statusMessage: 'That match is still waiting on a semi-final.',
    });
  }

  const byId = new Map(members.map((m) => [m.id, m]));
  const blue = fixture.blue_member_id ? byId.get(fixture.blue_member_id) : undefined;
  const red = fixture.red_member_id ? byId.get(fixture.red_member_id) : undefined;

  const mine = [blue?.profile_id, red?.profile_id].includes(profileId);
  if (!mine) {
    throw createError({ statusCode: 403, statusMessage: 'That is not your fixture.' });
  }

  const window = fixtureWindow(fixture.scheduled_at);
  if (!window.open) {
    const minutes = Math.ceil(window.secondsUntil / 60);
    throw createError({
      statusCode: 409,
      statusMessage: `The lobby opens 15 minutes before kick-off — ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} to go.`,
    });
  }

  const { data: active } = await db
    .from('catalogue_versions').select('id').eq('is_active', true).maybeSingle();

  // The catalogue was pinned when the season started (docs/03 section 9). It is the
  // one the whole season is played on, whatever has been published since.
  const catalogueVersionId = league.catalogue_version_id || active?.id;
  if (!catalogueVersionId) {
    throw createError({ statusCode: 503, statusMessage: 'No catalogue to play against.' });
  }

  const seed = `fixture-${fixture.id}`;
  const startsAt = new Date(Date.now() + LOBBY_SECONDS * 1000);

  const common = {
    status: 'DRAFTING' as const,
    source: 'LEAGUE' as const,
    catalogue_version_id: catalogueVersionId,
    seed,
    turn: 0,
    bonus: { BLUE: BONUS_SECONDS, RED: BONUS_SECONDS },
    starts_at: startsAt.toISOString(),
    deadline_at: new Date(startsAt.getTime() + ACTION_SECONDS * 1000).toISOString(),
    watch_speed: WATCH_SPEED,
    accepted_at: new Date().toISOString(),
  };

  let insert: Record<string, any>;

  if (fixture.stage === 'GHOST' || !red) {
    /**
     * A Ghost (docs/01 section 6). The manager keeps the side the schedule gave
     * them, and the agent takes the other — an odd league should not also mean a
     * manager who always drafts first against the Ghost.
     */
    const manager = blue ?? red;
    if (!manager) throw createError({ statusCode: 500, statusMessage: 'That fixture has no manager.' });

    const lineup = await snapshotLineup(db, manager.profile_id);
    if (!lineupComplete(lineup)) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Fill all five roster slots before playing.',
      });
    }

    const ghost = await botLineup(db, catalogueVersionId, lineup, seed);
    const managerIsBlue = fixture.blue_member_id === manager.id;

    insert = {
      ...common,
      challenger_id: manager.profile_id,
      opponent_id: null,
      bot_side: managerIsBlue ? 'RED' : 'BLUE',
      blue_id: managerIsBlue ? manager.profile_id : null,
      red_id: managerIsBlue ? null : manager.profile_id,
      blue_lineup: managerIsBlue ? lineup : ghost,
      red_lineup: managerIsBlue ? ghost : lineup,
    };
  } else {
    if (!blue) throw createError({ statusCode: 500, statusMessage: 'That fixture has no blue side.' });

    const [blueLineup, redLineup] = await Promise.all([
      snapshotLineup(db, blue.profile_id),
      snapshotLineup(db, red.profile_id),
    ]);

    const short = !lineupComplete(blueLineup) ? blue : !lineupComplete(redLineup) ? red : null;
    if (short) {
      throw createError({
        statusCode: 409,
        statusMessage: short.profile_id === profileId
          ? 'Fill all five roster slots before playing.'
          : `${short.team_name} has not set a full roster yet.`,
      });
    }

    insert = {
      ...common,
      // The opener is the challenger. It decides nothing — sides come from the
      // schedule — but both rows have to be filled for the duel to show up in the
      // other manager's list and light their Battle tab.
      challenger_id: profileId,
      opponent_id: blue.profile_id === profileId ? red.profile_id : blue.profile_id,
      blue_id: blue.profile_id,
      red_id: red.profile_id,
      blue_lineup: blueLineup,
      red_lineup: redLineup,
    };
  }

  const { data: duel, error } = await db.from('duels').insert(insert).select('id').single();

  if (error) {
    // The partial unique index from 0005: one live duel per pair, per direction.
    if (error.code === '23505') {
      throw createError({
        statusCode: 409,
        statusMessage: 'You already have a live duel with them. Finish that one first.',
      });
    }
    throw createError({ statusCode: 500, statusMessage: error.message });
  }

  /**
   * Claim the fixture with the duel, and only if nothing else has.
   *
   * `duel_id is null` in the WHERE is what makes the race safe: the request that
   * loses it has made a duel nobody is in, so it deletes it and returns the room
   * that won. Leaving the orphan would put a phantom live duel in somebody's list.
   */
  const { data: claimed } = await db
    .from('league_fixtures')
    .update({ duel_id: duel.id, status: 'PLAYING' })
    .eq('id', fixture.id)
    .is('duel_id', null)
    .select('duel_id')
    .maybeSingle();

  if (!claimed) {
    await db.from('duels').delete().eq('id', duel.id);
    const { data: current } = await db
      .from('league_fixtures').select('duel_id').eq('id', fixture.id).maybeSingle();

    if (current?.duel_id) return { duelId: current.duel_id, opened: false };
    throw createError({ statusCode: 500, statusMessage: 'Could not open that fixture.' });
  }

  return { duelId: duel.id, opened: true };
}

/**
 * Copy a decided result onto the fixture it was played for.
 *
 * Called from the moment the engine runs, not from the moment somebody finishes
 * watching: docs/01 section 8 is explicit that standings must not be holdable hostage
 * by a manager who refuses to open the app. The replay is still there to watch; the
 * table does not wait for it.
 *
 * Never throws. A duel that cannot update its fixture has still been played, and
 * failing the request that finished the draft would leave the match decided in the
 * duel and the player staring at an error.
 */
export async function recordFixtureResult(
  db: SupabaseClient,
  duelId: string,
  result: { winner?: string; gameLength?: number; boxScore?: Array<{ team: string; kills: number }> },
): Promise<void> {
  try {
    const { data: fixture } = await db
      .from('league_fixtures')
      .select('id, league_id, stage, bracket_key, blue_member_id, red_member_id, status')
      .eq('duel_id', duelId)
      .maybeSingle();

    if (!fixture || fixture.status === 'FINAL') return;

    const winnerSide = result.winner === 'BLUE' || result.winner === 'RED' ? result.winner : null;
    const kills = (team: string) =>
      (result.boxScore || [])
        .filter((row) => row.team === team)
        .reduce((n, row) => n + (row.kills ?? 0), 0);

    await db.from('league_fixtures').update({
      status: 'FINAL',
      winner_side: winnerSide,
      // Null on a Ghost win: the Ghost has no member row, and docs/01 section 6
      // keeps Ghost fixtures out of the standings anyway.
      winner_member_id: winnerSide === 'BLUE' ? fixture.blue_member_id
        : winnerSide === 'RED' ? fixture.red_member_id
          : null,
      game_length: result.gameLength ?? null,
      blue_kills: kills('BLUE'),
      red_kills: kills('RED'),
      played_at: new Date().toISOString(),
    }).eq('id', fixture.id);

    /**
     * And then: does this result end something?
     *
     * The last regular fixture draws the bracket; a semi fills in a side of the final; the
     * final crowns a champion and pays the placings (docs/01 section 7). All of it from
     * here, because this is the single place a fixture becomes FINAL, and docs/01 section 8
     * is explicit that the season must not wait on anybody opening the app — see
     * server/utils/leaguePlayoffs.ts for the longer version of that argument.
     *
     * `.eq('status', ...)` is not needed to make this safe: the early return above means
     * only the call that actually flipped this fixture to FINAL gets here, and everything
     * afterFixtureFinal does is idempotent anyway.
     */
    await afterFixtureFinal(db, fixture.league_id, fixture.stage);
  } catch (e: any) {
    console.warn(`[league] fixture result for duel ${duelId}: ${e?.message || e}`);
  }
}
