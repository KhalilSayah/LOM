/**
 * The end of a season: drawing the bracket, advancing it, and crowning somebody.
 *
 * docs/01 section 3 draws the shape (semis on day 12, a rest day, the final on day 14) and
 * docs/01 section 7 says what happens when the final is decided: the champion goes on the
 * honours board, the placings pay out, and collections are kept in full. shared/playoffs.ts
 * is the arithmetic. This module is the three writes.
 *
 * **When the bracket is generated.** Automatically, the moment the last regular fixture
 * goes FINAL — from the same place the result is written, which is the engine finishing the
 * match and not anybody opening the app. That is the argument docs/01 section 8 already
 * makes for the standings: a table that waits on somebody watching a replay is a table that
 * can be held hostage, and a bracket is worse, because six people are waiting on it to know
 * whether their season is over. Generating it on a read of the league screen would mean the
 * bracket appears when the first person looks, which is a different evening for each of them.
 *
 * There is an owner button as well (`/api/league/[id]/playoffs`), and it calls exactly this
 * function. It is a repair path, not a second way of doing it: the automatic call is inside
 * a `catch` that must not take a finished match down with it, so a failure there has to be
 * recoverable without a migration. It does not force anything — a league with a regular
 * fixture nobody has played is told how many are outstanding, because overriding that is a
 * forfeit, and forfeits are docs/05 section 7 and deliberately unbuilt.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { standings, type PlayedFixture } from '~~/shared/standings';
import {
  bracketFor, bracketFromSlots, bracketState, seasonPlacings,
  type Bracket, type BracketKey, type BracketResult, type BracketState, type BracketSlot,
} from '~~/shared/playoffs';
import { LEAGUE_SELECT, matchHourParts, membersOf, type LeagueRow, type MemberRow } from './league';
import { addDays, zonedToUtc } from './packDay';
import { settleSeason } from './seasonRewards';
import { recordSeasonEnd } from './leagueSeason';

/**
 * Where the playoff days land, counted from the last day of the regular season.
 *
 * docs/01 section 3 puts the semis on day 12, a rest day on 13 and the final on 14, of a
 * 14-day season whose regular fixtures end on day 11. Those gaps, kept relative so they
 * survive a league whose regular season was a different length. The rest day between is a
 * real row: 0009 keeps the calendar complete so the screen never has to infer a gap, and a
 * day off before the final is the bit of theatre that makes it a final.
 */
export const SEMI_DAY_GAP = 1;
export const FINAL_DAY_GAP = 3;

/** A league of two plays no semis, so its final needs no day off before it. */
export const SHORT_FINAL_DAY_GAP = 1;

export interface PlayoffRow {
  id: string;
  day_index: number;
  stage: string;
  bracket_key: BracketKey | null;
  blue_member_id: string | null;
  red_member_id: string | null;
  scheduled_at: string | null;
  status: string;
  duel_id: string | null;
  winner_member_id: string | null;
}

const FIXTURE_SELECT = `
  id, day_index, stage, bracket_key, blue_member_id, red_member_id,
  scheduled_at, status, duel_id, winner_member_id, winner_side, game_length,
  blue_kills, red_kills
`;

/** Playoff stages, as `league_fixtures.stage` stores them (migration 0013). */
export const PLAYOFF_STAGES = ['SEMI', 'GRAND_FINAL'] as const;

export const isPlayoffStage = (stage: string | null | undefined): boolean =>
  (PLAYOFF_STAGES as readonly string[]).includes(String(stage));

/** The final regular-season table, as member ids, best first. */
export function regularOrder(
  leagueId: string,
  members: MemberRow[],
  fixtures: any[],
): string[] {
  const played: PlayedFixture[] = fixtures.map((f) => ({
    stage: f.stage,
    status: f.status,
    blueMemberId: f.blue_member_id,
    redMemberId: f.red_member_id,
    winnerMemberId: f.winner_member_id,
    gameLength: f.game_length,
    blueKills: f.blue_kills,
    redKills: f.red_kills,
  }));

  // `standings()` only counts REGULAR fixtures, so the playoff rows in `fixtures` are
  // invisible to it — which is what seeds the bracket off the regular season rather than
  // off a table that the semis have already moved.
  return standings(members.map((m) => m.id), played, leagueId).map((row) => row.memberId);
}

/**
 * The instant a given day of this league's calendar kicks off.
 *
 * Counted from `starts_on` in the league's own timezone rather than by adding days to the
 * last fixture's timestamp: the match hour is a wall-clock time, and a season that crosses
 * a DST change would otherwise hold its final an hour early. Same reasoning, and the same
 * helpers, as buildFixtures in server/utils/league.ts.
 */
export function playoffKickOff(league: LeagueRow, dayIndex: number): string | null {
  if (!league.starts_on) return null;

  const { hour, minute } = matchHourParts(league.match_hour);
  const date = addDays(league.starts_on, dayIndex - 1);
  const [y, m, d] = date.split('-').map(Number);

  return zonedToUtc(y!, m!, d!, hour, league.timezone, minute).toISOString();
}

export interface PlayoffsResult {
  generated: boolean;
  /** Why not, in the words the owner's button needs to say. */
  reason?: string;
  /** Regular fixtures still waiting to be played, when that is the reason. */
  outstanding?: number;
}

/**
 * Draw the bracket, if the regular season is over and it has not been drawn.
 *
 * Idempotent, and that is the whole reliability story. The three guards — the league is
 * ACTIVE, no bracket row exists, every regular fixture is decided — are all read before the
 * insert, and the unique index on `(league_id, bracket_key)` from 0013 is what settles the
 * race the guards cannot: two managers finishing the last regular fixture in the same
 * instant both pass all three, and the whole bracket goes in as one statement, so the loser
 * is rejected entirely rather than halfway.
 */
export async function ensurePlayoffs(
  db: SupabaseClient,
  leagueId: string,
): Promise<PlayoffsResult> {
  const { data: leagueRow } = await db
    .from('leagues')
    .select(LEAGUE_SELECT)
    .eq('id', leagueId)
    .maybeSingle();

  if (!leagueRow) return { generated: false, reason: 'No such league.' };
  const league = leagueRow as LeagueRow;

  if (league.status === 'FINISHED') {
    return { generated: false, reason: `${league.name} is already finished.` };
  }
  if (league.status !== 'ACTIVE') {
    return { generated: false, reason: 'That season has not started yet.' };
  }

  const members = await membersOf(db, leagueId);
  const { data } = await db
    .from('league_fixtures')
    .select(FIXTURE_SELECT)
    .eq('league_id', leagueId)
    // This season only. A league on its second season has its first one's fixtures
    // sitting in the same table, all FINAL, and seeding a bracket off them would read
    // last season's table (migration 0014).
    .eq('season', league.season ?? 1);

  const fixtures = (data || []) as any[];

  if (fixtures.some((f) => f.bracket_key)) {
    return { generated: false, reason: 'The bracket is already drawn.' };
  }

  const regular = fixtures.filter((f) => f.stage === 'REGULAR');
  if (!regular.length) {
    return { generated: false, reason: 'That season has no fixtures.' };
  }

  /**
   * What has to be decided before the bracket can be seeded: every REGULAR fixture.
   *
   * Not the Ghosts. A Ghost settles nothing in the table (docs/01 section 6), nobody is
   * obliged to play one, and gating the playoffs on them would mean a league of three or
   * five could never reach its final because somebody skipped a bye. VOID counts as
   * decided — a voided fixture is one the owner has already said does not happen.
   */
  const outstanding = regular.filter((f) => f.status !== 'FINAL' && f.status !== 'VOID');
  if (outstanding.length) {
    return {
      generated: false,
      outstanding: outstanding.length,
      reason: outstanding.length === 1
        ? 'One regular fixture is still to be played.'
        : `${outstanding.length} regular fixtures are still to be played.`,
    };
  }

  const order = regularOrder(leagueId, members, fixtures);
  if (order.length < 2) {
    return { generated: false, reason: 'A bracket needs at least two managers.' };
  }

  const bracket = bracketFor(order);
  // No results yet, so this is the seeding and nothing more: both semis, and whichever
  // side of the final a bye already owns.
  const opening = bracketState(bracket, []);

  const lastDay = Math.max(...fixtures.map((f) => f.day_index ?? 0), 0);
  const hasSemis = bracket.matches.some((m) => m.stage === 'SEMI');

  const semiDay = lastDay + SEMI_DAY_GAP;
  const finalDay = lastDay + (hasSemis ? FINAL_DAY_GAP : SHORT_FINAL_DAY_GAP);
  const restDay = finalDay - 1;

  /**
   * A fallback kick-off, for a league with no `starts_on`.
   *
   * Launch always sets it, so this should never fire — but a playoff fixture with no
   * `scheduled_at` can never be opened (its lobby never comes round), which would brick the
   * end of a season rather than inconvenience it. Counting from the last fixture that does
   * have a time is less correct across a DST change and infinitely better than that.
   */
  const lastKickOff = fixtures
    .map((f) => f.scheduled_at)
    .filter(Boolean)
    .sort()
    .pop() as string | undefined;

  const kickOff = (dayIndex: number) => {
    const fromCalendar = playoffKickOff(league, dayIndex);
    if (fromCalendar) return fromCalendar;
    if (!lastKickOff) return null;
    const at = new Date(lastKickOff).getTime() + (dayIndex - lastDay) * 86400_000;
    return new Date(at).toISOString();
  };

  const rows: Record<string, any>[] = [];

  for (const m of bracket.matches) {
    const sides = opening.sides[m.key]!;
    const dayIndex = m.stage === 'SEMI' ? semiDay : finalDay;

    rows.push({
      league_id: leagueId,
      season: league.season ?? 1,
      day_index: dayIndex,
      stage: m.stage,
      bracket_key: m.key,
      blue_member_id: sides.blue,
      red_member_id: sides.red,
      scheduled_at: kickOff(dayIndex),
    });
  }

  // The day off before the final, as a real row. docs/01 section 3 has it on day 13.
  if (hasSemis && restDay > semiDay) {
    rows.push({
      league_id: leagueId,
      season: league.season ?? 1,
      day_index: restDay,
      stage: 'REST',
      blue_member_id: null,
      red_member_id: null,
      scheduled_at: null,
    });
  }

  const { error } = await db.from('league_fixtures').insert(rows);

  if (error) {
    // 23505: somebody else drew it a moment ago, which is a success with a different name.
    if (error.code === '23505') return { generated: false, reason: 'The bracket is already drawn.' };
    throw createError({ statusCode: 500, statusMessage: `Could not draw the bracket: ${error.message}` });
  }

  return { generated: true };
}

export interface LoadedBracket {
  bracket: Bracket;
  state: BracketState;
  /** The stored rows, by bracket slot. */
  rows: Map<BracketKey, PlayoffRow>;
}

/**
 * The bracket as it stands, rebuilt from the rows that are the record of it.
 *
 * Null when this league has no bracket. The seeding comes out of the semis (see
 * `bracketFromSlots`); only the order of the managers who missed the cut comes from the
 * live table, and that orders nothing docs/01 section 5 pays differently.
 */
export function loadBracket(
  leagueId: string,
  members: MemberRow[],
  fixtures: any[],
): LoadedBracket | null {
  const playoffRows = (fixtures as PlayoffRow[]).filter((f) => f.bracket_key);
  if (!playoffRows.length) return null;

  const rows = new Map<BracketKey, PlayoffRow>();
  for (const row of playoffRows) rows.set(row.bracket_key!, row);

  const slots: BracketSlot[] = playoffRows.map((f) => ({
    key: f.bracket_key!,
    blue: f.blue_member_id,
    red: f.red_member_id,
  }));

  const bracket = bracketFromSlots(slots, regularOrder(leagueId, members, fixtures));

  const results: BracketResult[] = playoffRows
    .filter((f) => f.status === 'FINAL')
    .map((f) => ({ key: f.bracket_key!, winnerMemberId: f.winner_member_id }));

  return { bracket, state: bracketState(bracket, results), rows };
}

/**
 * Carry a decided playoff match through to whatever it unlocks.
 *
 * A semi fills in a side of the final. The final finishes the season: the champion goes on
 * the league, the status becomes FINISHED — the value 0009 gave `leagues.status` and
 * nothing ever set — and the placings are paid.
 *
 * Idempotent at every step, because it is reachable twice: both managers can finish the
 * same match in the same instant, and the owner's button calls it too. The side-filling
 * update is conditional on the side still being null, and the payout has its own lock in
 * `season_rewards`.
 */
export async function advancePlayoffs(
  db: SupabaseClient,
  leagueId: string,
): Promise<{ finished: boolean; championMemberId: string | null }> {
  const { data: leagueRow } = await db
    .from('leagues')
    .select(LEAGUE_SELECT)
    .eq('id', leagueId)
    .maybeSingle();

  if (!leagueRow) return { finished: false, championMemberId: null };
  const league = leagueRow as LeagueRow;

  const members = await membersOf(db, leagueId);
  const { data } = await db
    .from('league_fixtures')
    .select(FIXTURE_SELECT)
    .eq('league_id', leagueId)
    // This season only. A league on its second season has its first one's fixtures
    // sitting in the same table, all FINAL, and seeding a bracket off them would read
    // last season's table (migration 0014).
    .eq('season', league.season ?? 1);

  const fixtures = (data || []) as any[];
  const loaded = loadBracket(leagueId, members, fixtures);
  if (!loaded) return { finished: false, championMemberId: null };

  const { bracket, state, rows } = loaded;

  /**
   * Fill in the sides the results have now decided — both at once, never one.
   *
   * Half a final is not a playable fixture (openFixture refuses it), and writing the first
   * semi's winner into blue as soon as it is known would decide the side *order* before the
   * other finalist exists: a fourth seed out of SF1 would keep blue over a second seed out
   * of SF2, when the better seed is supposed to draft first. So nothing is written until
   * both sides are known, and then they are written together, unconditionally, from the
   * state — which makes the write convergent rather than first-past-the-post.
   *
   * That leaves no stuck state when both semis finish at once. Each caller marks its own
   * fixture FINAL before it reads, so whichever caller reads *last* sees both results and
   * writes the pair; the one that read early sees one and writes nothing.
   */
  for (const match of bracket.matches) {
    const row = rows.get(match.key);
    const sides = state.sides[match.key];
    if (!row || !sides || row.status === 'FINAL') continue;
    if (!sides.blue || !sides.red) continue;
    if (row.blue_member_id === sides.blue && row.red_member_id === sides.red) continue;

    await db
      .from('league_fixtures')
      .update({ blue_member_id: sides.blue, red_member_id: sides.red })
      .eq('id', row.id)
      // Never reshuffle a match somebody is already in, or one already decided.
      .is('duel_id', null)
      .neq('status', 'FINAL');
  }

  if (!state.decided || !state.championMemberId) {
    return { finished: false, championMemberId: null };
  }

  /**
   * The season is over.
   *
   * `status = 'ACTIVE'` in the WHERE so the flip happens once; a second caller reads no
   * row back and skips to the payout, which has its own lock and will also find nothing
   * to do. The champion is written in the same update as the status, so there is never a
   * FINISHED league without one.
   */
  await db
    .from('leagues')
    .update({
      status: 'FINISHED',
      champion_member_id: state.championMemberId,
      finished_at: new Date().toISOString(),
    })
    .eq('id', leagueId)
    .eq('status', 'ACTIVE');

  await settleSeason(db, league, members, seasonPlacings(bracket, state));

  /**
   * The honours entry and everybody's Season Pack (docs/01 section 7 points 1 and 5).
   *
   * After the payout rather than before it, on the same reasoning the payout uses for
   * coming after the status flip: the money is the part a manager will notice missing, so
   * it goes first and the trophy cabinet follows. Both are idempotent, and neither throws.
   */
  await recordSeasonEnd(db, league, members, state.championMemberId, fixtures);

  return { finished: true, championMemberId: state.championMemberId };
}

/**
 * The one hook: a league fixture has just been decided, so see what that ends.
 *
 * Called from recordFixtureResult, which is the single place a fixture becomes FINAL.
 * Never throws, for the same reason that function does not: the match has been played, and
 * failing the request that finished the draft would leave the result written and the player
 * staring at an error. A bracket that could not be drawn is logged and can be drawn by the
 * owner's button.
 */
export async function afterFixtureFinal(
  db: SupabaseClient,
  leagueId: string,
  stage: string,
): Promise<void> {
  try {
    if (stage === 'REGULAR') {
      await ensurePlayoffs(db, leagueId);
    } else if (isPlayoffStage(stage)) {
      await advancePlayoffs(db, leagueId);
    }
  } catch (e: any) {
    console.error('[league] could not advance the season', {
      league: leagueId, stage, code: e?.code, message: e?.message,
    });
  }
}
