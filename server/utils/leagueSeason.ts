/**
 * A league that can be played more than once — docs/01 section 7.
 *
 * Two moments, and they are deliberately separate:
 *
 *   `recordSeasonEnd`   the grand final is decided. The honours board gets its entry and
 *                       everybody gets their Season Pack. This happens whether or not
 *                       anybody ever plays again, which is the point of it being here and
 *                       not in the reset.
 *   `startNextSeason`   the owner presses a button, days or weeks later. A new calendar,
 *                       a re-pinned catalogue, and a table that is empty because it is
 *                       asking about a different season rather than because anything was
 *                       deleted.
 *
 * Nothing is thrown away at a reset. docs/01 section 7 point 3 is explicit about
 * collections, and the same argument applies to the season itself: a league whose first
 * season is unreadable the moment its second starts has lost the only thing that makes a
 * second season worth playing. Season 1's calendar, results, replays, standings and
 * payouts are all still in their tables, scoped by `season` (migration 0014).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { matchDayCount } from '~~/shared/league';
import {
  buildFixtures, firstMatchDate, assertLaunchable,
  type LeagueRow, type MemberRow,
} from './league';

/** The pack type migration 0014 adds: one card, Epic at worst, unbuyable. */
export const SEASON_PACK = 'SEASON';

/**
 * The honours entry and the Season Pack, for a season that has just been decided.
 *
 * Idempotent in both halves, because the call site is `advancePlayoffs`, which is itself
 * reachable twice — the grand final finishing in two clients at once, and the owner's
 * repair button. The honours row is an upsert on `(league_id, season)`; the pack is granted
 * through `grant_pack_gift`, whose `(profile_id, reason)` unique is what makes handing out
 * the same campaign twice a no-op (migration 0008 says so in those words).
 *
 * Never throws. A season that cannot write its honours has still been won, and the request
 * that finished the grand final must not fail because of it.
 */
export async function recordSeasonEnd(
  db: SupabaseClient,
  league: LeagueRow,
  members: MemberRow[],
  championMemberId: string | null,
  fixtures: Array<{ day_index: number; stage: string }>,
): Promise<void> {
  const season = league.season ?? 1;

  try {
    const days = new Set(fixtures.map((f) => f.day_index));
    const restDays = new Set(
      fixtures.filter((f) => f.stage === 'REST').map((f) => f.day_index),
    );

    await db.from('league_seasons').upsert({
      league_id: league.id,
      season,
      starts_on: league.starts_on,
      started_at: league.started_at,
      finished_at: new Date().toISOString(),
      champion_member_id: championMemberId,
      days: days.size,
      match_days: days.size - restDays.size,
    }, { onConflict: 'league_id,season' });
  } catch (e: any) {
    console.error('[season] could not record the honours', {
      league: league.id, season, code: e?.code, message: e?.message,
    });
  }

  /**
   * docs/01 section 7 point 5: a Season Pack each, guaranteed Epic or better.
   *
   * Granted for finishing, not for winning — it is the thing that makes the end of a
   * season feel like a beginning, and a reward only the champion gets is a reward that
   * makes a sixth-place manager close the app. The placings already pay by position
   * (docs/01 section 5); this is flat on purpose.
   *
   * The reason key carries the league *and* the season, so a manager in three leagues
   * collects three, and a league that settles twice hands out one.
   */
  for (const member of members) {
    try {
      const { error } = await db.rpc('grant_pack_gift', {
        p_profile: member.profile_id,
        p_pack: SEASON_PACK,
        p_reason: `SEASON_PACK:${league.id}:${season}`,
        p_title: `${league.name} — season ${season} pack`,
        p_body: member.id === championMemberId
          ? 'For winning the league. One player, Epic at worst.'
          : 'For seeing the season out. One player, Epic at worst.',
      });
      if (error) throw error;
    } catch (e: any) {
      console.error('[season] could not grant a season pack', {
        league: league.id, season, member: member.id, code: e?.code, message: e?.message,
      });
    }
  }
}

export interface NextSeason {
  season: number;
  startsOn: string;
  days: number;
  matchDays: number;
  fixtures: number;
}

/**
 * Start the next season of a finished league — docs/01 section 7 point 4.
 *
 * The same shape as the original launch, and for the same reasons: the status flip carries
 * the old status *and* the old season number in its WHERE clause, so a double-tapped button
 * loses the race in the database rather than in a read taken a moment earlier; and if the
 * fixture insert then fails the flip is undone by hand, because there is no transaction
 * across two PostgREST calls and a league stuck ACTIVE with no calendar is unplayable.
 *
 * What it does not do is grant the starter pack the first launch grants. That pack exists so
 * nobody arrives at day 1 with nothing to field; a manager going into season 2 has a
 * collection, a squad and a Season Pack they were handed when season 1 ended.
 */
export async function startNextSeason(
  db: SupabaseClient,
  league: LeagueRow,
  members: MemberRow[],
): Promise<NextSeason> {
  if (league.status !== 'FINISHED') {
    throw createError({
      statusCode: 409,
      statusMessage: league.status === 'ACTIVE'
        ? `${league.name} is still being played.`
        : `${league.name} has not played a season yet.`,
    });
  }

  assertLaunchable(members);

  const { data: active } = await db
    .from('catalogue_versions').select('id').eq('is_active', true).maybeSingle();
  if (!active) throw createError({ statusCode: 503, statusMessage: 'No active catalogue to pin.' });

  const from = league.season ?? 1;
  const season = from + 1;
  const now = new Date();
  const startsOn = firstMatchDate(league, now);

  // Generated against the *new* season number, because the rows have to exist before the
  // column on `leagues` is allowed to disagree with them. `buildFixtures` works its own
  // start date out from the same `now`, so it lands on `startsOn` too.
  const fixtures = buildFixtures({ ...league, season }, members, now);

  const { data: claimed } = await db
    .from('leagues')
    .update({
      season,
      status: 'ACTIVE',
      starts_on: startsOn,
      started_at: now.toISOString(),
      finished_at: null,
      // The champion of the *current* season, so it is null while one is being played.
      // Last season's champion is on the honours board now (migration 0014).
      champion_member_id: null,
      // Re-pinned: docs/03 section 9 pins a catalogue per season, and a season played
      // months later should be played on the cards that exist by then.
      catalogue_version_id: active.id,
    })
    .eq('id', league.id)
    .eq('status', 'FINISHED')
    .eq('season', from)
    .select('id')
    .maybeSingle();

  if (!claimed) {
    throw createError({
      statusCode: 409,
      statusMessage: `Season ${season} of ${league.name} has already started.`,
    });
  }

  const { error } = await db.from('league_fixtures').insert(fixtures);

  if (error) {
    await db.from('league_fixtures')
      .delete().eq('league_id', league.id).eq('season', season);
    await db.from('leagues')
      .update({
        season: from,
        status: 'FINISHED',
        starts_on: league.starts_on,
        started_at: league.started_at,
        finished_at: league.finished_at ?? new Date().toISOString(),
        champion_member_id: league.champion_member_id,
      })
      .eq('id', league.id);
    throw createError({
      statusCode: 500,
      statusMessage: `Could not write the schedule: ${error.message}`,
    });
  }

  const days = new Set(fixtures.map((f) => f.day_index));

  return {
    season,
    startsOn,
    days: days.size,
    matchDays: matchDayCount(
      [...days].map((dayIndex) => ({
        dayIndex,
        rest: fixtures.some((f) => f.day_index === dayIndex && f.stage === 'REST'),
        pairings: [],
      })),
    ),
    fixtures: fixtures.length,
  };
}

/** The honours board: every season this league has finished, most recent first. */
export async function honoursOf(db: SupabaseClient, leagueId: string) {
  const { data } = await db
    .from('league_seasons')
    .select('season, starts_on, started_at, finished_at, champion_member_id, days, match_days')
    .eq('league_id', leagueId)
    .order('season', { ascending: false });

  return (data || []) as Array<{
    season: number;
    starts_on: string | null;
    started_at: string | null;
    finished_at: string | null;
    champion_member_id: string | null;
    days: number | null;
    match_days: number | null;
  }>;
}
