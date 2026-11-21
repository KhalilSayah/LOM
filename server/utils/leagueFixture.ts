import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { snapshotLineup, autoPick, autoBan, type DuelCard, type Lineup } from './duel';
import { botLineup } from './duelBot';
import { applyAction, draftPool, loadActions } from './duelRun';
import { championRoles } from './championRoles';
import {
  ACTION_SECONDS, BONUS_SECONDS, DRAFT_LENGTH, SLOTS, stepAt,
  type LockedAction, type Side, type Slot,
} from '~~/shared/draft';
import { LOBBY_SECONDS, WATCH_SPEED } from '~~/shared/duelRoom';
import { fixtureWindow, EARLY_START_LEAD_SECONDS } from '~~/shared/league';
import { afterFixtureFinal, isPlayoffStage } from './leaguePlayoffs';
import { draftedSides, type LeagueRow, type MemberRow } from './league';

/**
 * Playing a fixture.
 *
 * A league fixture is played in the duel room — the same twenty actions, the same
 * clock, the same engine (docs/05 section 0 planned it the other way round: the duel
 * was built first precisely so that a fixture could become "another thing that can
 * open a duel"). So there is no second draft implementation here. What this module
 * does is the joins that make a duel a fixture:
 *
 *   opening   — build the duel with the sides the schedule already decided, with its
 *               first clock at kick-off rather than at whenever somebody tapped
 *   readiness — both managers in early can start early, and only together
 *   recording — copy the decided result onto the fixture, for the table
 *   catching up — on any read of the league, finish what nobody finished: record a
 *               result whose write failed, and play a fixture nobody opened within a
 *               day of kick-off, with the agent on both sides
 *
 * Sides are the one real difference from a friendly. A friendly draws them at accept,
 * because otherwise challenging somebody would be worth first pick. A fixture does
 * not draw anything: the schedule assigned them weeks ago, and swapped them for the
 * second cycle, so that over a season everybody drafts first about as often.
 */

export interface FixtureRow {
  id: string;
  league_id: string;
  season?: number;
  day_index: number;
  stage: 'REGULAR' | 'GHOST' | 'REST' | 'SEMI' | 'GRAND_FINAL';
  /** 'SF1' | 'SF2' | 'FINAL' on a playoff row, null on everything else (migration 0013). */
  bracket_key?: string | null;
  blue_member_id: string | null;
  red_member_id: string | null;
  scheduled_at: string | null;
  status: string;
  duel_id: string | null;
  /** GHOST rows: the side the Ghost drafts from (migration 0016). Null reads as RED. */
  ghost_side?: 'BLUE' | 'RED' | null;
  blue_ready_at?: string | null;
  red_ready_at?: string | null;
}

/** What a route selects to hand a fixture to this module. */
export const FIXTURE_COLUMNS = `
  id, league_id, season, day_index, stage, bracket_key, blue_member_id, red_member_id,
  scheduled_at, status, duel_id, ghost_side, blue_ready_at, red_ready_at
`;

/**
 * How good a stand-in is: a bench common at level 1.
 *
 * A manager with an empty slot still has to field somebody, or one person's half-built
 * roster blocks the fixture for both of them for ever. The stand-in is drawn from the
 * pinned catalogue the way the Ghost's five are, but low enough that filling the slot
 * yourself is always better — 55 sits inside the Common band (40-67, docs/02 section 3).
 */
export const STAND_IN_OVR = 55;

/**
 * An unpredictable seed for the engine.
 *
 * It used to be `fixture-${id}`, and a fixture id is on every screen of the league:
 * anybody could run the sandbox on that seed with candidate drafts before kick-off and
 * know which one wins. The seed is written to the duel row once and the replay reads
 * it from there, so nothing needs to be able to recompute it.
 */
const freshSeed = () => `fixture-${randomBytes(16).toString('hex')}`;

/** A manager's five as it stands, with any empty slot filled by a stand-in. */
async function fieldLineup(
  db: SupabaseClient,
  catalogueVersionId: string,
  profileId: string,
  seed: string,
): Promise<{ lineup: Lineup; standIns: Slot[] }> {
  const lineup = await snapshotLineup(db, profileId);
  const missing = SLOTS.filter((s) => !lineup[s]);
  if (!missing.length) return { lineup, standIns: [] };

  // botLineup draws around the average OVR of the lineup it is handed. An anchor of one
  // card at STAND_IN_OVR is how it is asked for the bench rather than the manager's level.
  const anchor = Object.fromEntries(SLOTS.map((s) => [s, null])) as unknown as Lineup;
  anchor.TOP = { ovr: STAND_IN_OVR } as DuelCard;

  const bench = await botLineup(db, catalogueVersionId, anchor, `${seed}:bench:${profileId}`);
  const out = { ...lineup } as Lineup;
  const standIns: Slot[] = [];

  for (const slot of missing) {
    const card = bench[slot];
    if (!card) continue;
    // Marked on the snapshot so a screen reading the duel can say so too.
    out[slot] = { ...card, standIn: true } as DuelCard;
    standIns.push(slot);
  }

  // A catalogue with no card for a role leaves that slot empty, and the engine rates an
  // empty slot at 30 (ratingFor). Worse, but it still produces a result — which is the rule.
  return { lineup: out, standIns };
}

interface CreateOptions {
  /** Who tapped the button. Null when nobody did and the agent is playing it. */
  openerProfileId: string | null;
  /** The agent drafts every side: nobody opened it within a day of kick-off. */
  auto: boolean;
}

/** The checks every way into a fixture's room has to pass. */
function assertOpenable(fixture: FixtureRow) {
  if (fixture.stage === 'REST') {
    throw createError({ statusCode: 400, statusMessage: 'That is a rest day.' });
  }
  if (fixture.status === 'VOID') {
    throw createError({ statusCode: 409, statusMessage: 'That fixture was voided.' });
  }
  if (fixture.status === 'FINAL') {
    throw createError({ statusCode: 409, statusMessage: 'That fixture has been played.' });
  }

  /**
   * A playoff fixture whose sides are not both known yet.
   *
   * The final exists as a row from the moment the bracket is drawn, with a date on it, and
   * fills its sides in as the semis resolve (migration 0013 relaxed the sides constraint for
   * exactly that). So it has to be refused here, and refused *before* the Ghost branch
   * — which would otherwise read the pending red side as "no opponent" and hand the
   * grand final to the auto-draft agent.
   */
  if (isPlayoffStage(fixture.stage) && !(fixture.blue_member_id && fixture.red_member_id)) {
    throw createError({
      statusCode: 409,
      statusMessage: 'That match is still waiting on a semi-final.',
    });
  }
}

/**
 * Build the duel for a fixture and claim the fixture with it.
 *
 * Idempotent on purpose, and that is the whole reliability story: both managers tap
 * the same button within a second of each other (or a read of the league catches up
 * the same overdue fixture twice), and whichever request lands second finds
 * `duel_id` already set — or loses the race on the claim and reads it back. Nobody
 * ever gets a second room for the same fixture.
 */
async function createFixtureDuel(
  db: SupabaseClient,
  league: LeagueRow,
  fixture: FixtureRow,
  members: MemberRow[],
  options: CreateOptions,
): Promise<{ duelId: string; opened: boolean }> {
  if (fixture.duel_id) return { duelId: fixture.duel_id, opened: false };
  assertOpenable(fixture);

  const byId = new Map(members.map((m) => [m.id, m]));
  const sides = draftedSides(fixture);
  const blue = sides.blue ? byId.get(sides.blue) : undefined;
  const red = sides.red ? byId.get(sides.red) : undefined;

  const { data: active } = await db
    .from('catalogue_versions').select('id').eq('is_active', true).maybeSingle();

  // The catalogue was pinned when the season started (docs/03 section 9). It is the
  // one the whole season is played on, whatever has been published since.
  const catalogueVersionId = league.catalogue_version_id || active?.id;
  if (!catalogueVersionId) {
    throw createError({ statusCode: 503, statusMessage: 'No catalogue to play against.' });
  }

  const seed = freshSeed();
  const now = Date.now();
  const window = fixtureWindow(fixture.scheduled_at, now);

  /**
   * When the first clock starts: kick-off, not the tap.
   *
   * The room opens fifteen minutes early so people can arrive, and it used to start the
   * draft four seconds after whoever arrived first — which handed the early bird a draft
   * against the agent while the other manager was still on their way. Now an early room is
   * a lobby until kick-off (both managers saying they are ready can start it sooner; see
   * markFixtureReady), and a late one starts after the usual four seconds. A room the
   * agent is playing for both sides starts at once: there is nobody to wait for.
   */
  const startsAt = options.auto
    ? new Date(now)
    : new Date(Math.max(now + LOBBY_SECONDS * 1000, window.kickOffAt || 0));

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
    accepted_at: new Date(now).toISOString(),
  };

  let insert: Record<string, any>;
  const standIns: Record<Side, Slot[]> = { BLUE: [], RED: [] };

  if (fixture.stage === 'GHOST' || !blue || !red) {
    /**
     * A Ghost (docs/01 section 6). The manager takes the side the schedule gave them —
     * which alternates now (migration 0016) — and the agent takes the other.
     */
    const manager = blue ?? red;
    if (!manager) throw createError({ statusCode: 500, statusMessage: 'That fixture has no manager.' });

    if (!options.auto && options.openerProfileId !== manager.profile_id) {
      throw createError({ statusCode: 403, statusMessage: 'That is not your fixture.' });
    }

    const managerSide: Side = blue ? 'BLUE' : 'RED';
    const fielded = await fieldLineup(db, catalogueVersionId, manager.profile_id, seed);
    standIns[managerSide] = fielded.standIns;
    const ghost = await botLineup(db, catalogueVersionId, fielded.lineup, seed);
    const managerIsBlue = managerSide === 'BLUE';

    insert = {
      ...common,
      challenger_id: manager.profile_id,
      opponent_id: null,
      bot_side: managerIsBlue ? 'RED' : 'BLUE',
      blue_id: managerIsBlue ? manager.profile_id : null,
      red_id: managerIsBlue ? null : manager.profile_id,
      blue_lineup: managerIsBlue ? fielded.lineup : ghost,
      red_lineup: managerIsBlue ? ghost : fielded.lineup,
    };
  } else {
    const opener = options.openerProfileId;
    if (!options.auto && opener !== blue.profile_id && opener !== red.profile_id) {
      throw createError({ statusCode: 403, statusMessage: 'That is not your fixture.' });
    }

    const [blueField, redField] = await Promise.all([
      fieldLineup(db, catalogueVersionId, blue.profile_id, seed),
      fieldLineup(db, catalogueVersionId, red.profile_id, seed),
    ]);
    standIns.BLUE = blueField.standIns;
    standIns.RED = redField.standIns;

    // The opener is the challenger. It decides nothing — sides come from the schedule —
    // but both rows have to be filled for the duel to show up in the other manager's
    // list and light their Battle tab. With nobody opening it, blue is as good as red.
    const challenger = options.auto || !opener ? blue.profile_id : opener;

    insert = {
      ...common,
      challenger_id: challenger,
      opponent_id: challenger === blue.profile_id ? red.profile_id : blue.profile_id,
      blue_id: blue.profile_id,
      red_id: red.profile_id,
      blue_lineup: blueField.lineup,
      red_lineup: redField.lineup,
    };
  }

  const { data: duel, error } = await db.from('duels').insert(insert).select('id').single();

  if (error) {
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
    .update({
      duel_id: duel.id,
      status: 'PLAYING',
      stand_ins: standIns.BLUE.length || standIns.RED.length ? standIns : null,
      auto_played_at: options.auto ? new Date(now).toISOString() : null,
    })
    .eq('id', fixture.id)
    .is('duel_id', null)
    .neq('status', 'FINAL')
    .neq('status', 'VOID')
    .select('duel_id')
    .maybeSingle();

  if (!claimed) {
    await db.from('duels').delete().eq('id', duel.id);
    const { data: current } = await db
      .from('league_fixtures').select('duel_id').eq('id', fixture.id).maybeSingle();

    if (current?.duel_id) return { duelId: current.duel_id, opened: false };
    throw createError({ statusCode: 500, statusMessage: 'Could not open that fixture.' });
  }

  fixture.duel_id = duel.id;
  fixture.status = 'PLAYING';
  return { duelId: duel.id, opened: true };
}

/**
 * Open the room for a fixture, or hand back the one that is already open.
 *
 * Allowed from fifteen minutes before kick-off, with the draft held until kick-off.
 * `ready` is the manager saying "start as soon as we are both here" — see
 * markFixtureReady. A fixture past its automatic deadline (a day after kick-off) is not
 * opened for a live draft any more: it is played by the agent there and then, and the
 * caller is handed the result to watch.
 */
export async function openFixture(
  db: SupabaseClient,
  league: LeagueRow,
  fixture: FixtureRow,
  members: MemberRow[],
  profileId: string,
  options: { ready?: boolean } = {},
): Promise<{ duelId: string; opened: boolean; autoPlayed?: boolean }> {
  const mySide = sideOfProfile(fixture, members, profileId);
  if (!mySide) {
    throw createError({ statusCode: 403, statusMessage: 'That is not your fixture.' });
  }

  if (fixture.duel_id) {
    await refreshLobbyLineup(db, league, fixture, profileId, mySide);
    if (options.ready !== undefined) await markFixtureReady(db, fixture, members, profileId, options.ready);
    return { duelId: fixture.duel_id, opened: false };
  }

  assertOpenable(fixture);

  const window = fixtureWindow(fixture.scheduled_at);
  if (!window.open) {
    const minutes = Math.ceil(window.secondsUntil / 60);
    throw createError({
      statusCode: 409,
      statusMessage: `The lobby opens 15 minutes before kick-off — ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} to go.`,
    });
  }

  if (window.overdue && fixture.stage !== 'GHOST') {
    const duelId = await autoPlayFixture(db, league, fixture, members);
    return { duelId, opened: false, autoPlayed: true };
  }

  const out = await createFixtureDuel(db, league, fixture, members, {
    openerProfileId: profileId,
    auto: false,
  });

  if (options.ready) await markFixtureReady(db, fixture, members, profileId, true);
  return out;
}

/** Which side of the draft this profile is on in this fixture, if either. */
export function sideOfProfile(
  fixture: FixtureRow,
  members: MemberRow[],
  profileId: string,
): Side | null {
  const byId = new Map(members.map((m) => [m.id, m]));
  const sides = draftedSides(fixture);
  if (sides.blue && byId.get(sides.blue)?.profile_id === profileId) return 'BLUE';
  if (sides.red && byId.get(sides.red)?.profile_id === profileId) return 'RED';
  return null;
}

/**
 * Re-read the caller's five while the room is still a lobby.
 *
 * The room snapshots both lineups when it is created, which can be fifteen minutes
 * before kick-off — and a manager who walks in at kick-off minus five having just fixed
 * their roster should play with the roster they fixed. Only their own side, only while
 * nothing has been drafted and the first clock has not started.
 */
async function refreshLobbyLineup(
  db: SupabaseClient,
  league: LeagueRow,
  fixture: FixtureRow,
  profileId: string,
  side: Side,
) {
  try {
    const { data: duel } = await db
      .from('duels')
      .select('id, status, turn, starts_at, seed, catalogue_version_id')
      .eq('id', fixture.duel_id!)
      .maybeSingle();

    if (!duel || duel.status !== 'DRAFTING' || duel.turn !== 0) return;
    if (!duel.starts_at || new Date(duel.starts_at).getTime() <= Date.now() + 2000) return;

    const catalogueVersionId = duel.catalogue_version_id || league.catalogue_version_id;
    if (!catalogueVersionId) return;

    const fielded = await fieldLineup(db, catalogueVersionId, profileId, duel.seed);
    await db.from('duels')
      .update({
        [side === 'BLUE' ? 'blue_lineup' : 'red_lineup']: fielded.lineup,
        updated_at: new Date().toISOString(),
      })
      .eq('id', duel.id)
      .eq('turn', 0)
      .eq('status', 'DRAFTING');

    const { data: row } = await db
      .from('league_fixtures').select('stand_ins').eq('id', fixture.id).maybeSingle();
    const standIns = { BLUE: [], RED: [], ...(row?.stand_ins || {}) } as Record<Side, Slot[]>;
    standIns[side] = fielded.standIns;
    await db.from('league_fixtures')
      .update({ stand_ins: standIns.BLUE.length || standIns.RED.length ? standIns : null })
      .eq('id', fixture.id);
  } catch (e: any) {
    // A stale lineup is a worse game, not a broken one. The room still opens.
    console.warn(`[league] could not refresh a lobby lineup for ${fixture.id}: ${e?.message || e}`);
  }
}

/**
 * "Start as soon as we are both here."
 *
 * Before kick-off only: after it the draft has started (or starts in four seconds)
 * anyway. When both sides are ready — the Ghost always is — and the room exists, its
 * first clock is pulled forward to a few seconds from now. Both clients are subscribed
 * to the duel row, so the lobby countdown moves without anybody refreshing.
 *
 * Saying you are not ready clears your flag; it cannot pull a start back once it has
 * been brought forward, because the other manager may already be watching that count.
 */
export async function markFixtureReady(
  db: SupabaseClient,
  fixture: FixtureRow,
  members: MemberRow[],
  profileId: string,
  ready: boolean,
): Promise<{ blueReady: boolean; redReady: boolean; startsAt: string | null }> {
  const side = sideOfProfile(fixture, members, profileId);
  if (!side) throw createError({ statusCode: 403, statusMessage: 'That is not your fixture.' });

  const window = fixtureWindow(fixture.scheduled_at);
  if (!window.open) {
    throw createError({ statusCode: 409, statusMessage: 'The lobby is not open yet.' });
  }

  const column = side === 'BLUE' ? 'blue_ready_at' : 'red_ready_at';
  const { data: row, error } = await db
    .from('league_fixtures')
    .update({ [column]: ready ? new Date().toISOString() : null })
    .eq('id', fixture.id)
    .select('stage, ghost_side, blue_ready_at, red_ready_at, duel_id')
    .maybeSingle();

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  const ghostSide = row?.stage === 'GHOST' ? (row.ghost_side === 'BLUE' ? 'BLUE' : 'RED') : null;
  const blueReady = ghostSide === 'BLUE' || Boolean(row?.blue_ready_at);
  const redReady = ghostSide === 'RED' || Boolean(row?.red_ready_at);
  let startsAt: string | null = null;

  if (blueReady && redReady && row?.duel_id && !window.started) {
    const at = new Date(Date.now() + EARLY_START_LEAD_SECONDS * 1000);
    const { data: moved } = await db
      .from('duels')
      .update({
        starts_at: at.toISOString(),
        deadline_at: new Date(at.getTime() + ACTION_SECONDS * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.duel_id)
      .eq('status', 'DRAFTING')
      .eq('turn', 0)
      // Only ever forward. A second "ready" must not push a start that is already close.
      .gt('starts_at', at.toISOString())
      .select('starts_at')
      .maybeSingle();
    startsAt = moved?.starts_at ?? null;
  }

  return { blueReady, redReady, startsAt };
}

// --- the agent, on both sides ------------------------------------------------

/** Deterministic noise for the agent, from the duel's seed — reproducible from the record. */
function seededRand(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return h / 4294967296;
  };
}

/**
 * Draft every remaining action of a duel with the agent, to the end.
 *
 * Built from what server/utils/duelRun.ts exports rather than by changing it: the agent's
 * choice is `autoPick` / `autoBan`, exactly what an expired turn gets, and the write is
 * `applyAction` — the same lock, the same unique indexes, and the same `finish` that runs
 * the engine, records this fixture, pays the managers and advances the season. The only
 * difference from the clock-driven path is that nobody waits thirty seconds a turn for
 * people who are not coming.
 *
 * `applyAction` marks what it writes as a human action, so the actions written here are
 * re-marked `auto` afterwards; the replay should say the agent drafted them.
 *
 * Safe against a second caller doing the same thing at the same moment: a lost race on
 * an index is a 23505, which re-reads where the winner left the draft and carries on.
 */
export async function draftToTheEnd(db: SupabaseClient, duelId: string): Promise<boolean> {
  const { data: row } = await db.from('duels').select('*').eq('id', duelId).maybeSingle();
  if (!row || row.status !== 'DRAFTING') return false;

  const duel: any = row;
  let actions: LockedAction[] = await loadActions(db, duelId);
  const firstIdx = actions.length;

  const [roles, pool] = await Promise.all([
    championRoles(db, duel.catalogue_version_id),
    draftPool(db, duel.catalogue_version_id),
  ]);

  const rand = seededRand(`${duel.seed}:agent`);
  let guard = 0;

  while (duel.status === 'DRAFTING' && guard++ < DRAFT_LENGTH * 2) {
    // The log is the draft; the cursor follows it (the same rule catchUp applies).
    if (actions.length > duel.turn) duel.turn = actions.length;
    if (duel.turn >= DRAFT_LENGTH) break;

    const step = stepAt(duel.turn)!;
    const blueLineup = duel.blue_lineup as Lineup;
    const redLineup = duel.red_lineup as Lineup;
    const mine = step.side === 'BLUE' ? blueLineup : redLineup;
    const theirs = step.side === 'BLUE' ? redLineup : blueLineup;

    const chosen = step.kind === 'PICK'
      ? autoPick(mine, theirs, actions, step.side, pool, roles, rand)
      : { ...autoBan(theirs, actions, step.side === 'BLUE' ? 'RED' : 'BLUE', pool, roles, rand), slot: null };

    try {
      actions = await applyAction(db, duel, actions, {
        side: step.side,
        kind: step.kind,
        championKey: chosen.championKey,
        championName: chosen.championName,
        slot: (chosen as any).slot ?? null,
      });
    } catch (e: any) {
      if (e?.code !== '23505') throw e;
      const { data: fresh } = await db.from('duels').select('*').eq('id', duelId).maybeSingle();
      if (!fresh) return false;
      Object.assign(duel, fresh);
      actions = await loadActions(db, duelId);
    }
  }

  await db.from('duel_actions')
    .update({ auto: true })
    .eq('duel_id', duelId)
    .gte('idx', firstIdx);

  // A draft that reached twenty actions but did not finish (a lost race at the last
  // pick) is finished by whoever next reads the duel; catchUp does that already.
  return duel.status !== 'DRAFTING';
}

/**
 * Play a fixture with the agent drafting for both managers.
 *
 * For a fixture nobody opened by a day after kick-off (docs/01 section 8, docs/05
 * section 1: a match always produces a result). If a room exists but its draft was
 * abandoned, it is that draft that gets finished — whatever the managers did lock is
 * kept, and the agent plays on from there.
 */
export async function autoPlayFixture(
  db: SupabaseClient,
  league: LeagueRow,
  fixture: FixtureRow,
  members: MemberRow[],
): Promise<string> {
  let duelId = fixture.duel_id;

  if (!duelId) {
    const made = await createFixtureDuel(db, league, fixture, members, {
      openerProfileId: null,
      auto: true,
    });
    duelId = made.duelId;
  }

  await draftToTheEnd(db, duelId);
  return duelId;
}

// --- recording ---------------------------------------------------------------

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
 * duel and the player staring at an error. A write that fails here is not lost:
 * `catchUpLeague` finds the fixture still PLAYING beside a finished duel on the next
 * read of the league, and calls this again.
 */
export async function recordFixtureResult(
  db: SupabaseClient,
  duelId: string,
  result: { winner?: string; gameLength?: number; boxScore?: Array<{ team: string; kills: number }> },
): Promise<void> {
  try {
    const { data: fixture } = await db
      .from('league_fixtures')
      .select('id, league_id, stage, bracket_key, blue_member_id, red_member_id, ghost_side, status')
      .eq('duel_id', duelId)
      .maybeSingle();

    if (!fixture || fixture.status === 'FINAL') return;

    const winnerSide = result.winner === 'BLUE' || result.winner === 'RED' ? result.winner : null;
    const sides = draftedSides(fixture as any);
    const kills = (team: string) =>
      (result.boxScore || [])
        .filter((row) => row.team === team)
        .reduce((n, row) => n + (row.kills ?? 0), 0);

    /**
     * `status <> FINAL` in the WHERE, and the row read back: only the call that actually
     * flipped this fixture goes on to ask what the result ends. The reconcile on a league
     * read and the engine finishing can both arrive here for the same duel.
     */
    const { data: flipped, error } = await db.from('league_fixtures').update({
      status: 'FINAL',
      winner_side: winnerSide,
      // Null on a Ghost win: the Ghost has no member row, and docs/01 section 6
      // keeps Ghost fixtures out of the standings anyway.
      winner_member_id: winnerSide === 'BLUE' ? sides.blue
        : winnerSide === 'RED' ? sides.red
          : null,
      game_length: result.gameLength ?? null,
      blue_kills: kills('BLUE'),
      red_kills: kills('RED'),
      played_at: new Date().toISOString(),
    })
      .eq('id', fixture.id)
      .neq('status', 'FINAL')
      .select('id')
      .maybeSingle();

    if (error) throw error;
    if (!flipped) return;

    /**
     * And then: does this result end something?
     *
     * The last regular fixture draws the bracket; a semi fills in a side of the final; the
     * final crowns a champion and pays the placings (docs/01 section 7). All of it from
     * here, because this is the single place a fixture becomes FINAL, and docs/01 section 8
     * is explicit that the season must not wait on anybody opening the app — see
     * server/utils/leaguePlayoffs.ts for the longer version of that argument.
     */
    await afterFixtureFinal(db, fixture.league_id, fixture.stage);
  } catch (e: any) {
    console.warn(`[league] fixture result for duel ${duelId}: ${e?.message || e}`);
  }
}

// --- catching up -------------------------------------------------------------

/**
 * How much catching up one read of the league may do.
 *
 * Playing a fixture for both sides is twenty writes and an engine run, so a read that
 * found a week of abandoned fixtures could take long enough to time out. It does a few,
 * and the next read does a few more. Recording a result that is already decided is cheap
 * and is not limited.
 */
const CATCH_UP_BUDGET = 3;
const CATCH_UP_MS = 4000;

/**
 * Bring a league up to date with the clock, before anybody reads it.
 *
 * The same pattern the duel room uses (catchUp in server/utils/duelRun.ts): nothing
 * schedules this, it runs whenever a league is read, and every step is idempotent so two
 * readers at once do the work once.
 *
 *   1. A PLAYING fixture whose duel has a result is recorded. That is a result write
 *      that failed — recordFixtureResult swallows its errors so the match is not lost,
 *      and this is where it gets its second chance, bracket and payouts included.
 *   2. A PLAYING fixture whose duel has vanished goes back to SCHEDULED.
 *   3. A fixture nobody opened by a day after kick-off is played by the agent for both
 *      sides, and a draft abandoned for that long is finished the same way. Not Ghosts:
 *      nobody is obliged to play a bye, and nothing waits on one.
 *
 * Returns true when anything changed, so the caller knows to re-read.
 */
export async function catchUpLeague(
  db: SupabaseClient,
  league: LeagueRow,
  members: MemberRow[],
): Promise<boolean> {
  if (league.status !== 'ACTIVE') return false;

  const started = Date.now();
  let budget = CATCH_UP_BUDGET;
  let changed = false;

  const { data, error } = await db
    .from('league_fixtures')
    .select(FIXTURE_COLUMNS)
    .eq('league_id', league.id)
    .eq('season', league.season ?? 1)
    .in('status', ['SCHEDULED', 'PLAYING'])
    .order('scheduled_at', { ascending: true });

  if (error || !data?.length) return false;
  const rows = data as unknown as FixtureRow[];

  const playing = rows.filter((f) => f.status === 'PLAYING');
  const duelIds = playing.map((f) => f.duel_id).filter(Boolean) as string[];
  const { data: duels } = duelIds.length
    ? await db.from('duels').select('id, status, result').in('id', duelIds)
    : { data: [] as any[] };
  const duelById = new Map((duels || []).map((d: any) => [d.id, d]));

  for (const f of playing) {
    try {
      if (!f.duel_id) {
        const { data: reset } = await db.from('league_fixtures')
          .update({ status: 'SCHEDULED' })
          .eq('id', f.id).eq('status', 'PLAYING').is('duel_id', null)
          .select('id').maybeSingle();
        if (reset) changed = true;
        continue;
      }

      const duel = duelById.get(f.duel_id);
      if (!duel) continue;

      if ((duel.status === 'WATCHING' || duel.status === 'COMPLETE') && duel.result) {
        await recordFixtureResult(db, duel.id, duel.result);
        changed = true;
      } else if (
        duel.status === 'DRAFTING'
        && fixtureWindow(f.scheduled_at).overdue
        && budget > 0
        && Date.now() - started < CATCH_UP_MS
      ) {
        budget -= 1;
        await draftToTheEnd(db, duel.id);
        changed = true;
      }
    } catch (e: any) {
      console.error('[league] catch-up on a playing fixture failed', {
        league: league.id, fixture: f.id, message: e?.message,
      });
    }
  }

  for (const f of rows) {
    if (budget <= 0 || Date.now() - started >= CATCH_UP_MS) break;
    if (f.status !== 'SCHEDULED' || f.duel_id || f.stage === 'GHOST' || f.stage === 'REST') continue;
    if (!f.blue_member_id || !f.red_member_id) continue;
    if (!fixtureWindow(f.scheduled_at).overdue) continue;

    budget -= 1;
    try {
      await autoPlayFixture(db, league, f, members);
      changed = true;
    } catch (e: any) {
      console.error('[league] could not auto-play an overdue fixture', {
        league: league.id, fixture: f.id, message: e?.message,
      });
    }
  }

  return changed;
}
