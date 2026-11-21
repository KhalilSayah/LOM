/**
 * Sponsors: what a brand asks of your five, and what it pays when they deliver.
 *
 * A sponsor is not passive income. Every contract carries a **demand** — three starters
 * from the LCK, nobody above Epic, win inside half an hour — and the money splits into an
 * appearance fee that always pays and a bonus that only pays when the demand is met. That
 * is the whole design: signing a sponsor is a constraint you accept on how you build and
 * draft, not a tap you turn on. A sponsor that paid the same whatever you fielded would be
 * a number going up on its own, which is not a game.
 *
 * Demands are evaluated here, in `shared/`, because three places need the same answer: the
 * server when it pays, the sponsor screen when it shows what you would earn, and the tests.
 * Every kind is decidable from the lineup snapshot the duel already stores and the result
 * the engine already produced — nothing here needs a lookup, which is what keeps a payout
 * explainable from the match you just watched.
 */

export const SPONSOR_TIERS = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON'] as const;
export type SponsorTier = (typeof SPONSOR_TIERS)[number];

/**
 * How many contracts a manager can hold at once.
 *
 * Two, so that signing one is a choice between demands rather than a collection of all of
 * them. The database allows up to four (migration 0012) so raising this is a constant, not
 * a migration.
 */
export const SPONSOR_SLOTS = 2;

/**
 * How many matches a signed contract runs before it can be released for nothing.
 *
 * A demand you can swap out of between matches is not a demand: you would sign whichever
 * brand happened to match the five you already meant to field, and the constraint — the
 * whole point of a sponsor — would cost you nothing. Three matches is about three evenings,
 * long enough that signing is a plan rather than a reaction.
 *
 * Leaving early is allowed, as a buy-out priced at the signing bonus. A commitment with no
 * way out is a trap, and a trap is not a decision either.
 */
export const SPONSOR_TERM = 3;

/** What it costs to tear up a contract before its term is up. */
export const buyoutCost = (signingBonus: number) => Math.max(0, Math.round(signingBonus));

/** The rarity ladder, for MAX_RARITY. Index order is the band order. */
const RARITY_ORDER = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON'];

export type SponsorDemand =
  /** At least `min` starters from one region. */
  | { kind: 'REGION'; region: string; min: number }
  /** At least `min` starters who shared a real team in the same season. */
  | { kind: 'CORE'; min: number }
  /** Average starter OVR at most `ovr` — a brand that backs the cheap squad. */
  | { kind: 'MAX_OVR'; ovr: number }
  /** Nobody in the five above this band. */
  | { kind: 'MAX_RARITY'; rarity: string }
  /** At least `min` starters from a season in [from, to]. */
  | { kind: 'SEASON_RANGE'; from: number; to: number; min: number }
  /** Team kills at or above `min`. */
  | { kind: 'KILLS'; min: number }
  /** Just win. */
  | { kind: 'WIN' }
  /** Win inside `minutes`. */
  | { kind: 'FAST_WIN'; minutes: number }
  /** A sponsor with nothing to ask: the appearance fee is all there is. */
  | { kind: 'NONE' };

/** One starter, as much of it as a demand can read. */
export interface SponsorStarter {
  ovr: number;
  rarity?: string | null;
  region?: string | null;
  team?: string | null;
  season?: number | null;
}

export interface SponsorMatch {
  starters: SponsorStarter[];
  won: boolean;
  /** This side's kills. */
  kills: number;
  /** Seconds, as the engine reports it. */
  gameLength: number;
}

const bandIndex = (rarity: string | null | undefined) => {
  const i = RARITY_ORDER.indexOf(String(rarity || '').toUpperCase());
  // An unknown band must not pass a cap by accident: treat it as the top.
  return i === -1 ? RARITY_ORDER.length - 1 : i;
};

/** The biggest group of starters who shared a team in the same season. */
export function largestCore(starters: SponsorStarter[]): number {
  const counts = new Map<string, number>();
  for (const s of starters) {
    if (!s.team || !s.season) continue;
    const key = `${s.team}|${s.season}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.values()].reduce((max, n) => Math.max(max, n), 0);
}

/**
 * Is the demand satisfied by this match?
 *
 * A demand on the five is read off the lineup, a demand on the game is read off the result.
 * An empty lineup fails every lineup demand rather than passing it vacuously — "all five
 * from the LCK" with no cards is not a thing anyone earned.
 */
export function demandMet(demand: SponsorDemand | null | undefined, match: SponsorMatch): boolean {
  if (!demand) return true;
  const { starters } = match;

  switch (demand.kind) {
    case 'NONE':
      return true;

    case 'REGION': {
      const want = demand.region.toUpperCase();
      const have = starters.filter((s) => String(s.region || '').toUpperCase() === want).length;
      return have >= demand.min;
    }

    case 'CORE':
      return largestCore(starters) >= demand.min;

    case 'MAX_OVR': {
      if (!starters.length) return false;
      const mean = starters.reduce((n, s) => n + (s.ovr || 0), 0) / starters.length;
      return mean <= demand.ovr;
    }

    case 'MAX_RARITY': {
      if (!starters.length) return false;
      const cap = bandIndex(demand.rarity);
      return starters.every((s) => bandIndex(s.rarity) <= cap);
    }

    case 'SEASON_RANGE': {
      const have = starters.filter(
        (s) => typeof s.season === 'number' && s.season >= demand.from && s.season <= demand.to,
      ).length;
      return have >= demand.min;
    }

    case 'KILLS':
      return match.kills >= demand.min;

    case 'WIN':
      return match.won;

    case 'FAST_WIN':
      return match.won && match.gameLength <= demand.minutes * 60;

    default:
      return false;
  }
}

/**
 * The demand in a line of English, generated rather than stored.
 *
 * The catalogue holds the demand as data and nothing else: a hand-written label beside it
 * is a second source of truth that drifts the first time a threshold is tuned in SQL.
 */
export function demandLabel(demand: SponsorDemand | null | undefined): string {
  if (!demand) return 'No conditions';
  switch (demand.kind) {
    case 'NONE':
      return 'No conditions';
    case 'REGION':
      return `Field ${demand.min} starter${demand.min === 1 ? '' : 's'} from ${demand.region}`;
    case 'CORE':
      return `Field ${demand.min} players from the same real team and season`;
    case 'MAX_OVR':
      return `Average squad rating of ${demand.ovr} or under`;
    case 'MAX_RARITY':
      return `Nobody above ${demand.rarity.charAt(0) + demand.rarity.slice(1).toLowerCase()} in the five`;
    case 'SEASON_RANGE':
      return `Field ${demand.min} starter${demand.min === 1 ? '' : 's'} from ${demand.from}–${demand.to}`;
    case 'KILLS':
      return `Take ${demand.min} kills as a team`;
    case 'WIN':
      return 'Win the match';
    case 'FAST_WIN':
      return `Win inside ${demand.minutes} minutes`;
    default:
      return 'Unknown terms';
  }
}

export interface SignedSponsor {
  key: string;
  name: string;
  tier: SponsorTier;
  slot: number;
  basePayout: number;
  bonusPayout: number;
  demand: SponsorDemand;
}

export interface SponsorPayoutLine {
  key: string;
  name: string;
  slot: number;
  /** The appearance fee, always paid. */
  base: number;
  /** The bonus, paid only when `met`. */
  bonus: number;
  credits: number;
  met: boolean;
  demand: string;
}

/**
 * What the signed contracts pay for one finished match.
 *
 * `rate` is 1 for a real opponent and 0.5 for a Ghost, so sponsor money follows the same
 * halving as everything else a Ghost pays (docs/01 section 6) rather than becoming the way
 * around it.
 */
export function sponsorPayout(
  signed: SignedSponsor[],
  match: SponsorMatch,
  rate = 1,
): { credits: number; lines: SponsorPayoutLine[] } {
  const lines = signed
    .slice()
    .sort((a, b) => a.slot - b.slot)
    .map((s) => {
      const met = demandMet(s.demand, match);
      const base = Math.round((s.basePayout || 0) * rate);
      const bonus = met ? Math.round((s.bonusPayout || 0) * rate) : 0;
      return {
        key: s.key,
        name: s.name,
        slot: s.slot,
        base,
        bonus,
        credits: base + bonus,
        met,
        demand: demandLabel(s.demand),
      };
    });

  return { credits: lines.reduce((n, l) => n + l.credits, 0), lines };
}

// --- the sponsor pack --------------------------------------------------------

/**
 * Price and odds for the pack that produces sponsors.
 *
 * Card packs keep their prices and weights in `pack_types` so a balance pass is an UPDATE
 * (migration 0004 makes that argument). These live in code instead, because the sponsor
 * catalogue is a dozen hand-written contracts rather than a generated set: its tiering is
 * part of the design, not a dial, and a second pack table for one row would be ceremony.
 */
export const SPONSOR_PACK = {
  key: 'SPONSOR',
  name: 'Sponsor meeting',
  blurb: 'One contract on the table. Read the terms before you sign.',
  price: 600,
  weights: { COMMON: 46, RARE: 30, EPIC: 17, LEGENDARY: 6, ICON: 1 } as Record<SponsorTier, number>,
} as const;

/** A contract you already hold cannot be signed twice, so it pays out instead. */
export const SPONSOR_DUPLICATE_CREDITS: Record<SponsorTier, number> = {
  COMMON: 60,
  RARE: 120,
  EPIC: 250,
  LEGENDARY: 500,
  ICON: 900,
};

/** Weighted tier draw. */
export function rollSponsorTier(rng: () => number): SponsorTier {
  const entries = Object.entries(SPONSOR_PACK.weights) as [SponsorTier, number][];
  const total = entries.reduce((n, [, w]) => n + w, 0);
  let roll = rng() * total;
  for (const [tier, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return tier;
  }
  return 'COMMON';
}

/**
 * Which contract comes out of a meeting.
 *
 * Prefers a brand the manager does not already hold, inside the tier that was rolled, and
 * walks the ladder down towards Common and then up towards Icon when that tier is
 * exhausted — the same shape as the card roll in server/utils/roll.ts, and for the same
 * reason: a pack that hands back something you cannot use feels broken even when the
 * duplicate pays.
 *
 * A null `def` means every brand in the catalogue is already held, and the caller pays the
 * duplicate rate for the tier it rolled. `tier` is always the tier that was *rolled*, not
 * the tier that was found, because that is what the duplicate is priced against.
 */
export function pickSponsor<T extends { key: string; tier: SponsorTier }>(
  catalogue: T[],
  ownedKeys: Set<string>,
  rng: () => number,
): { def: T | null; tier: SponsorTier } {
  const tier = rollSponsorTier(rng);
  const start = SPONSOR_TIERS.indexOf(tier);

  const order: SponsorTier[] = [
    tier,
    ...SPONSOR_TIERS.slice(0, start).reverse(),
    ...SPONSOR_TIERS.slice(start + 1),
  ];

  for (const band of order) {
    const options = catalogue.filter((d) => d.tier === band && !ownedKeys.has(d.key));
    if (options.length) {
      return { def: options[Math.floor(rng() * options.length)]!, tier };
    }
  }

  return { def: null, tier };
}
