/**
 * Paying a finished season.
 *
 * docs/01 section 5, last row: 1500 / 900 / 500 / 250 for finishing 1st / 2nd / 3rd-4th /
 * else. It is the one line of that table that could not be wired until a league had a
 * finish, which docs/12 section 7 said in so many words. shared/playoffs.ts decides who
 * finished where, shared/rewards.ts says what a placing pays, and this is the part that
 * touches the ledger.
 *
 * The discipline is the one payOne() in server/utils/rewards.ts already uses, because the
 * failure it guards against is the same one: a season can be settled twice. Two managers
 * can finish the grand final in the same instant by nudging the same expired deadline, and
 * the owner has a repair button that calls the same code. So the `season_rewards` row is
 * written *first*, with no Credits on it, and the unique index on
 * `(league_id, season, profile_id)` is what makes the second attempt a no-op rather than a
 * second payday.
 *
 * Order within one payout: claim, then Credits, then the receipt. There is no transaction
 * to be had over PostgREST (see persistOpening for the long version of that argument), so
 * the sequence is chosen for survivable failures. A crash after the claim pays nothing
 * twice. A crash after the Credits leaves a row saying 0 beside Credits that did move —
 * visible and fixable, and a great deal better than the other order, which would pay twice.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { seasonSettlement, seasonPlacingLabel } from '~~/shared/rewards';
import type { Placing } from '~~/shared/playoffs';
import { moveCredits } from './openPack';
import type { LeagueRow, MemberRow } from './league';

export interface SeasonPayout {
  memberId: string | null;
  profileId: string;
  teamName: string;
  placing: number;
  credits: number;
  label: string;
}

/**
 * Pay every manager their placing, once.
 *
 * Returns only what this call actually paid. A second call over the same season returns an
 * empty list, which is the honest answer: nothing happened, because it already had.
 *
 * Never throws. A season that cannot pay has still been won, and the request that finished
 * the grand final must not fail because a payout did — the same call recordFixtureResult
 * and payMatchRewards both make. A failure here is logged loudly, because an unpaid season
 * is a bug somebody has to hear about.
 */
export async function settleSeason(
  db: SupabaseClient,
  league: LeagueRow,
  members: MemberRow[],
  placings: Placing[],
): Promise<SeasonPayout[]> {
  const byId = new Map(members.map((m) => [m.id, m]));
  const paid: SeasonPayout[] = [];
  const season = league.season ?? 1;

  /**
   * Who has already been settled, read before anything is owed.
   *
   * The rule half of the idempotency (`seasonSettlement` in shared/rewards.ts says why it
   * is there and not here); the index half is the claim insert below. Reading first is not
   * redundant with the index — it is what makes a second settle cost two queries instead of
   * one rejected insert per manager, and what makes the returned list honest about having
   * paid nothing.
   */
  const { data: existing } = await db
    .from('season_rewards')
    .select('member_id')
    .eq('league_id', league.id)
    .eq('season', season);

  const already = (existing || [])
    .map((row: any) => row.member_id)
    .filter(Boolean) as string[];

  for (const owed of seasonSettlement(placings, already)) {
    const member = byId.get(owed.memberId);
    // A manager who has left is not in `members` any more. Their placing is skipped
    // rather than paid to nobody; everyone still in the league is paid regardless.
    if (!member) continue;

    try {
      const { credits, label } = owed;

      // The claim. Losing this race means this season has already been settled.
      const { data: claim, error: claimError } = await db
        .from('season_rewards')
        .insert({
          league_id: league.id,
          season,
          member_id: member.id,
          profile_id: member.profile_id,
          // `place` in SQL, `placing` everywhere else: PLACING is a reserved key word in
          // Postgres, so the column could not have the name the code uses for it. See
          // supabase/migrations/0013_playoffs.sql.
          place: owed.placing,
        })
        .select('id')
        .single();

      if (claimError || !claim) {
        if (claimError && claimError.code !== '23505') throw claimError;
        continue;
      }

      if (credits > 0) {
        await moveCredits(db, member.profile_id, credits, 'SEASON', league.id);
      }

      const detail = {
        label,
        place: owed.placing,
        teamName: member.team_name,
        leagueName: league.name,
        champion: owed.placing === 1,
      };

      await db.from('season_rewards').update({ credits, detail }).eq('id', claim.id);

      paid.push({
        memberId: member.id,
        profileId: member.profile_id,
        teamName: member.team_name,
        placing: owed.placing,
        credits,
        label,
      });
    } catch (e: any) {
      console.error('[season] placing payout failed', {
        league: league.id, member: owed.memberId, code: e?.code, message: e?.message,
      });
    }
  }

  return paid;
}

/** What a manager was paid for a finished season, for the honours board. */
export async function seasonPayouts(
  db: SupabaseClient,
  leagueId: string,
  season = 1,
): Promise<Map<string, { placing: number; credits: number; label: string }>> {
  const out = new Map<string, { placing: number; credits: number; label: string }>();

  const { data } = await db
    .from('season_rewards')
    .select('member_id, place, credits, detail')
    .eq('league_id', leagueId)
    .eq('season', season);

  for (const row of (data || []) as any[]) {
    if (!row.member_id) continue;
    out.set(row.member_id, {
      placing: row.place,
      credits: row.credits,
      label: row.detail?.label || seasonPlacingLabel(row.place),
    });
  }

  return out;
}
