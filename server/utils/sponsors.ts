/**
 * Sponsor contracts: reading the book, signing, releasing, and pulling a new one.
 *
 * The rules — what a demand means, what it is worth, what the pack costs — all live in
 * shared/sponsors.ts. This is the database side only: which contracts a manager holds,
 * which of them are live, and the service-role writes that change that. Nothing here is
 * reachable from a client without going through a Nitro route, because a client that could
 * write manager_sponsors could sign the Icon contract for nothing.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  SPONSOR_SLOTS, SPONSOR_PACK, SPONSOR_DUPLICATE_CREDITS, SPONSOR_TERM, buyoutCost,
  demandLabel, pickSponsor,
  type SignedSponsor, type SponsorDemand, type SponsorTier,
} from '~~/shared/sponsors';

const DEFINITION_SELECT =
  'key, name, blurb, tier, signing_bonus, base_payout, bonus_payout, demand, accent, sort';

export interface SponsorDefinitionRow {
  key: string;
  name: string;
  blurb: string | null;
  tier: SponsorTier;
  signing_bonus: number;
  base_payout: number;
  bonus_payout: number;
  demand: SponsorDemand;
  accent: string | null;
  sort: number;
}

export interface ContractRow {
  id: string;
  sponsor_key: string;
  slot: number | null;
  credits_earned: number;
  matches_paid: number;
  matches_since_signed: number;
  acquired_at: string;
  signed_at: string | null;
}

/** One contract as every screen wants to read it: the terms, flattened and in English. */
export const toSponsor = (def: SponsorDefinitionRow, held?: ContractRow | null) => ({
  key: def.key,
  name: def.name,
  blurb: def.blurb,
  tier: def.tier,
  signingBonus: def.signing_bonus,
  basePayout: def.base_payout,
  bonusPayout: def.bonus_payout,
  demand: def.demand,
  demandLabel: demandLabel(def.demand),
  accent: def.accent,
  owned: Boolean(held),
  slot: held?.slot ?? null,
  signed: held ? held.slot !== null : false,
  creditsEarned: held?.credits_earned ?? 0,
  matchesPaid: held?.matches_paid ?? 0,
  acquiredAt: held?.acquired_at ?? null,

  // The term, and what leaving early would cost. Both go to the screen so a release
  // button can say what it does before it is pressed.
  term: SPONSOR_TERM,
  matchesIntoTerm: Math.min(SPONSOR_TERM, held?.matches_since_signed ?? 0),
  termServed: (held?.matches_since_signed ?? 0) >= SPONSOR_TERM,
  buyout: buyoutCost(def.signing_bonus),
});

export async function sponsorCatalogue(db: SupabaseClient): Promise<SponsorDefinitionRow[]> {
  const { data } = await db
    .from('sponsor_definitions')
    .select(DEFINITION_SELECT)
    .eq('is_active', true)
    .order('sort');
  return (data || []) as SponsorDefinitionRow[];
}

export async function contractsFor(db: SupabaseClient, profileId: string): Promise<ContractRow[]> {
  const { data } = await db
    .from('manager_sponsors')
    .select('id, sponsor_key, slot, credits_earned, matches_paid, matches_since_signed, acquired_at, signed_at')
    .eq('profile_id', profileId);
  return (data || []) as ContractRow[];
}

/**
 * The contracts that are live, in the shape shared/sponsors.ts pays out against.
 *
 * Only signed rows: a contract in the drawer is owned and worth nothing, which is the
 * decision the two slots exist to force.
 */
export async function signedSponsors(db: SupabaseClient, profileId: string): Promise<SignedSponsor[]> {
  const { data } = await db
    .from('manager_sponsors')
    .select('slot, sponsor_definitions!inner ( key, name, tier, base_payout, bonus_payout, demand )')
    .eq('profile_id', profileId)
    .not('slot', 'is', null);

  return (data || []).map((row: any) => ({
    key: row.sponsor_definitions.key,
    name: row.sponsor_definitions.name,
    tier: row.sponsor_definitions.tier,
    slot: row.slot,
    basePayout: row.sponsor_definitions.base_payout,
    bonusPayout: row.sponsor_definitions.bonus_payout,
    demand: row.sponsor_definitions.demand,
  }));
}

/** The whole book: the catalogue, what is held, and what is live. */
export async function sponsorBook(db: SupabaseClient, profileId: string) {
  const [catalogue, held] = await Promise.all([
    sponsorCatalogue(db),
    contractsFor(db, profileId),
  ]);

  const byKey = new Map(held.map((h) => [h.sponsor_key, h]));
  const sponsors = catalogue.map((def) => toSponsor(def, byKey.get(def.key)));

  const slots = Array.from({ length: SPONSOR_SLOTS }, (_, slot) =>
    sponsors.find((s) => s.slot === slot) ?? null);

  return {
    slots,
    slotCount: SPONSOR_SLOTS,
    sponsors,
    owned: sponsors.filter((s) => s.owned),
    drawer: sponsors.filter((s) => s.owned && !s.signed),
    pack: SPONSOR_PACK,
  };
}

/**
 * Which contract comes out of a meeting — the rule itself is in shared/sponsors.ts, so it
 * can be tested without a database. Re-exported here so the route has one import.
 */
export { pickSponsor };

export const duplicateCredits = (tier: SponsorTier) => SPONSOR_DUPLICATE_CREDITS[tier] ?? 0;
