/**
 * Paying a finished match.
 *
 * docs/01 section 5 is the table; shared/rewards.ts is the arithmetic; this is the part
 * that touches the database. One row in `match_rewards` per manager per duel, written
 * *before* anything is granted, because that row is the idempotency lock: finish() in
 * duelRun.ts can be reached twice in the same instant by two clients nudging the same
 * expired deadline, and the second one has to be a no-op rather than a second payday.
 *
 * The order inside a payout is the same argument persistOpening makes: there is no
 * transaction to be had over PostgREST, so the sequence is chosen for survivable failures.
 * Claim, then Credits, then XP, then the receipt. A crash after the claim pays nothing
 * twice; a crash after the Credits leaves XP unawarded and a receipt that says so.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { matchPayout, GHOST_PAID_PER_DAY, GHOST_SHARE, type MatchPayout } from '~~/shared/rewards';
import { sponsorPayout, type SponsorStarter } from '~~/shared/sponsors';
import { SLOTS, type Side } from '~~/shared/draft';
import { applyXp } from './roll';
import { moveCredits } from './openPack';
import { configuredWindow } from './packDay';
import { signedSponsors } from './sponsors';

export interface MatchReward {
  credits: number;
  cardXp: number;
  won: boolean;
  ghost: boolean;
  detail: Record<string, unknown>;
}

/** What the result screen reads back. */
export async function rewardFor(
  db: SupabaseClient,
  duelId: string,
  profileId: string,
): Promise<MatchReward | null> {
  const { data } = await db
    .from('match_rewards')
    .select('credits, card_xp, won, ghost, detail')
    .eq('duel_id', duelId)
    .eq('profile_id', profileId)
    .maybeSingle();

  if (!data) return null;
  return {
    credits: data.credits,
    cardXp: data.card_xp,
    won: data.won,
    ghost: data.ghost,
    detail: (data.detail || {}) as Record<string, unknown>,
  };
}

/**
 * Was this the first win of the season for this manager, in this league?
 *
 * Only league fixtures have a season to be first in. Called after the fixture has been
 * marked FINAL, so the fixture being asked about is excluded by id rather than by status —
 * which is also what makes the answer stable if this ever runs twice.
 *
 * Scoped to the fixture's own `season` (migration 0014), which is the difference between
 * "the first win of a season" and "the first win ever". A league on its second season has
 * its first one's wins in the same table, and without this the 200 would be payable exactly
 * once in a league's whole life.
 */
async function isFirstLeagueWin(db: SupabaseClient, duelId: string): Promise<boolean> {
  const { data: fixture } = await db
    .from('league_fixtures')
    .select('id, league_id, season, winner_member_id, stage')
    .eq('duel_id', duelId)
    .maybeSingle();

  if (!fixture?.winner_member_id || fixture.stage !== 'REGULAR') return false;

  const { count } = await db
    .from('league_fixtures')
    .select('id', { count: 'exact', head: true })
    .eq('league_id', fixture.league_id)
    .eq('season', fixture.season ?? 1)
    .eq('winner_member_id', fixture.winner_member_id)
    .eq('status', 'FINAL')
    .neq('id', fixture.id);

  return (count ?? 0) === 0;
}

/** Card XP onto the collection rows the five starters came from. */
async function awardCardXp(
  db: SupabaseClient,
  profileId: string,
  awards: { cardKey: string; xp: number }[],
): Promise<number> {
  const wanted = new Map(awards.filter((a) => a.xp > 0).map((a) => [a.cardKey, a.xp]));
  if (!wanted.size) return 0;

  /**
   * Matched through the manager's own collection rather than by looking the card_key up in
   * the catalogue: `card_key` repeats across catalogue versions, and the row that has to be
   * levelled is the one this manager owns, not whichever version the query happened to find.
   */
  const { data: owned } = await db
    .from('collection_cards')
    .select('id, level, xp, card_definitions!inner ( card_key )')
    .eq('profile_id', profileId);

  let granted = 0;
  for (const row of (owned || []) as any[]) {
    const key = row.card_definitions?.card_key;
    const gain = key ? wanted.get(key) : undefined;
    if (!gain) continue;

    const next = applyXp(row.level ?? 1, row.xp ?? 0, gain);
    const { error } = await db
      .from('collection_cards')
      .update({ level: next.level, xp: next.xp })
      .eq('id', row.id);

    if (!error) granted += gain;
  }
  return granted;
}

/**
 * Pay one manager for one finished duel.
 *
 * Returns null when there was nothing to do — already paid, or this side is the agent.
 */
async function payOne(
  db: SupabaseClient,
  duel: any,
  result: any,
  profileId: string,
  side: Side,
  packDay: string,
): Promise<MatchReward | null> {
  // The claim. Losing this race means somebody else already paid this duel.
  const { data: claim, error: claimError } = await db
    .from('match_rewards')
    .insert({ duel_id: duel.id, profile_id: profileId, pack_day: packDay })
    .select('id')
    .single();

  if (claimError || !claim) {
    if (claimError && claimError.code !== '23505') throw claimError;
    return null;
  }

  const ghost = Boolean(duel.bot_side);
  const won = result?.winner === side;
  const lineup = (side === 'BLUE' ? duel.blue_lineup : duel.red_lineup) || {};

  const grades = new Map<string, string>();
  let kills = 0;
  for (const row of result?.boxScore || []) {
    if (row.team !== side) continue;
    if (row.cardKey) grades.set(row.cardKey, row.grade);
    kills += row.kills ?? 0;
  }

  const starters = SLOTS
    .map((slot) => lineup[slot])
    .filter(Boolean)
    .map((card: any) => ({
      cardKey: card.cardKey,
      name: card.name,
      slot: card.slot,
      grade: grades.get(card.cardKey) ?? null,
    }));

  /**
   * The Ghost allowance (shared/rewards.ts).
   *
   * Counted off the payouts themselves rather than a separate tally that could drift away
   * from them — the same choice migration 0004 made for per-day pack limits. The claim row
   * written a moment ago carries zero Credits, so it cannot count itself.
   */
  let creditsAllowed = true;
  if (ghost) {
    const { count } = await db
      .from('match_rewards')
      .select('id', { count: 'exact', head: true })
      .eq('profile_id', profileId)
      .eq('pack_day', packDay)
      .eq('ghost', true)
      .gt('credits', 0);

    creditsAllowed = (count ?? 0) < GHOST_PAID_PER_DAY;
  }

  const firstWinOfSeason = won && !ghost && duel.source === 'LEAGUE'
    ? await isFirstLeagueWin(db, duel.id)
    : false;

  const payout: MatchPayout = matchPayout({
    won, ghost, creditsAllowed, firstWinOfSeason, starters,
  });

  // Sponsors read the same five and the same result. A withheld payout rates at zero, so
  // the contract lines still say what the demand was and whether it was met.
  const signed = await signedSponsors(db, profileId);
  const sponsorMatch = {
    starters: SLOTS
      .map((slot) => lineup[slot])
      .filter(Boolean)
      .map((card: any): SponsorStarter => ({
        ovr: card.ovr,
        rarity: card.rarity,
        region: card.region,
        team: card.team,
        season: card.season,
      })),
    won,
    kills,
    gameLength: result?.gameLength ?? 0,
  };
  const rate = creditsAllowed ? (ghost ? GHOST_SHARE : 1) : 0;
  const sponsors = sponsorPayout(signed, sponsorMatch, rate);

  const credits = payout.credits + sponsors.credits;

  if (credits > 0) {
    await moveCredits(db, profileId, credits, 'MATCH', duel.id);
  }

  const cardXp = await awardCardXp(db, profileId, payout.cardXp);

  // What each live contract earned, so the sponsor screen can show a running total.
  for (const line of sponsors.lines) {
    const held = signed.find((s) => s.key === line.key);
    if (!held) continue;
    const { data: row } = await db
      .from('manager_sponsors')
      .select('id, credits_earned, matches_paid, matches_since_signed')
      .eq('profile_id', profileId)
      .eq('sponsor_key', line.key)
      .maybeSingle();
    if (!row) continue;
    await db.from('manager_sponsors').update({
      credits_earned: row.credits_earned + line.credits,
      matches_paid: row.matches_paid + 1,
      // The term counts matches played under the contract, met or not — serving it is
      // about honouring the deal, not about collecting on it.
      matches_since_signed: row.matches_since_signed + 1,
    }).eq('id', row.id);
  }

  const detail = {
    lines: payout.lines,
    cardXp: payout.cardXp.map((award) => ({
      ...award,
      name: starters.find((s) => s.cardKey === award.cardKey)?.name ?? award.cardKey,
    })),
    sponsors: sponsors.lines,
    sponsorCredits: sponsors.credits,
    matchCredits: payout.credits,
    creditsWithheld: payout.creditsWithheld,
    firstWinOfSeason,
  };

  await db.from('match_rewards').update({
    won, ghost, credits, card_xp: cardXp, detail,
  }).eq('id', claim.id);

  return { credits, cardXp, won, ghost, detail };
}

/**
 * Pay both managers for a duel the engine has just decided.
 *
 * Never throws. A duel that cannot pay has still been played, and failing the request that
 * finished the draft would leave the match decided and a player staring at an error — the
 * same call recordFixtureResult makes. A failure here is logged and loud, because an
 * unpaid match is a bug somebody has to hear about.
 */
export async function payMatchRewards(db: SupabaseClient, duel: any, result: any): Promise<void> {
  try {
    const { packDay } = configuredWindow(useRuntimeConfig());

    const sides: Array<{ profileId: string; side: Side }> = [];
    if (duel.blue_id) sides.push({ profileId: duel.blue_id, side: 'BLUE' });
    if (duel.red_id) sides.push({ profileId: duel.red_id, side: 'RED' });

    for (const { profileId, side } of sides) {
      await payOne(db, duel, result, profileId, side, packDay);
    }
  } catch (e: any) {
    console.error('[rewards] match payout failed', {
      duel: duel?.id, code: e?.code, message: e?.message, details: e?.details,
    });
  }
}
