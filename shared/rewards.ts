/**
 * What a finished match pays — docs/01-game-loop.md section 5.
 *
 * Pure arithmetic, no database, no clock, so the numbers can be unit-tested and so the
 * result screen can explain a payout with the same code that granted it. A reward the
 * manager cannot reconcile against what they just watched is a reward they will assume is
 * broken.
 *
 * Until this existed, Credits came only from duplicate pulls (see DUPLICATE_CREDITS in
 * server/utils/roll.ts, which says so) — the shop was funded by the thing the shop sells.
 * This is the faucet that closes that circle.
 */

/** docs/01 section 5, as written. The XP figures are per starter. */
export const MATCH_REWARDS = {
  play: 50,
  win: 100,
  /** Per starter who graded S or better. */
  sGrade: 25,
  /** Once per league season, on the first win that counts. */
  firstWin: 200,
  xp: {
    play: 20,
    win: 15,
    sGrade: 40,
  },
} as const;

/** docs/01 section 6: a Ghost pays Credits and card XP at half rate. */
export const GHOST_SHARE = 0.5;

/**
 * How many Ghost matches a day pay Credits at all.
 *
 * Not in the spec. The spec's Ghost is the bye in an odd league — one a day, unavoidable,
 * and halving it is enough. But /api/duel/queue/bot will hand out an agent opponent on
 * demand, which makes an unbounded Ghost a Credit faucet with a tap on it: open, draft
 * badly, collect. Past this many in a pack-day a Ghost still pays card XP — the cards you
 * play should keep improving — and stops paying Credits.
 */
export const GHOST_PAID_PER_DAY = 3;

/** S+ counts as an S-grade. The spec names one tier; the engine produces two above A. */
export const S_GRADES = ['S', 'S+'] as const;

export const isSGrade = (grade: string | null | undefined): boolean =>
  !!grade && (S_GRADES as readonly string[]).includes(grade);

export interface GradedStarter {
  cardKey: string;
  name?: string;
  slot?: string;
  grade?: string | null;
}

export interface MatchPayoutInput {
  /** Did this manager win? A draw is not a thing the engine produces. */
  won: boolean;
  /** Played against the agent: half rate, and no first-win bonus. */
  ghost: boolean;
  /** False once the Ghost allowance is spent: XP still accrues, Credits do not. */
  creditsAllowed?: boolean;
  /** First win of a league season, already decided by the caller. */
  firstWinOfSeason?: boolean;
  /** The five that played, with the grade the box score gave them. */
  starters: GradedStarter[];
}

export interface PayoutLine {
  label: string;
  credits: number;
}

export interface CardXpAward {
  cardKey: string;
  xp: number;
  grade: string | null;
}

export interface MatchPayout {
  credits: number;
  /** One line per reason, in the order they are worth explaining. */
  lines: PayoutLine[];
  cardXp: CardXpAward[];
  /** Total XP handed out, for the ledger row. */
  xpTotal: number;
  ghost: boolean;
  /** True when the Ghost allowance withheld Credits that would otherwise have been paid. */
  creditsWithheld: boolean;
}

/** Half-rate rounds rather than truncates, so a 25 does not quietly become a 12. */
const share = (value: number, ghost: boolean) =>
  ghost ? Math.round(value * GHOST_SHARE) : value;

/**
 * Everything a finished match pays one manager.
 *
 * The lines are the receipt. They are built even when `creditsAllowed` is false, with the
 * Credits zeroed, because "the Ghost allowance is spent" is information and an empty result
 * screen is not.
 */
export function matchPayout(input: MatchPayoutInput): MatchPayout {
  const { won, ghost, starters } = input;
  const allowed = input.creditsAllowed !== false;
  const lines: PayoutLine[] = [];

  const credit = (label: string, amount: number) => {
    const value = share(amount, ghost);
    if (value > 0) lines.push({ label, credits: allowed ? value : 0 });
    return allowed ? value : 0;
  };

  let credits = 0;
  credits += credit(ghost ? 'Ghost match' : 'Match played', MATCH_REWARDS.play);
  if (won) credits += credit('Win', MATCH_REWARDS.win);

  const sGraded = starters.filter((s) => isSGrade(s.grade));
  for (const starter of sGraded) {
    credits += credit(`${starter.name || starter.cardKey} · ${starter.grade}`, MATCH_REWARDS.sGrade);
  }

  // A Ghost does not count toward the standings (docs/01 section 6), so it cannot be the
  // win a season is opened with either.
  if (won && !ghost && input.firstWinOfSeason) {
    credits += credit('First win of the season', MATCH_REWARDS.firstWin);
  }

  const perStarter = share(MATCH_REWARDS.xp.play, ghost) + (won ? share(MATCH_REWARDS.xp.win, ghost) : 0);
  const cardXp: CardXpAward[] = starters.map((starter) => ({
    cardKey: starter.cardKey,
    grade: starter.grade ?? null,
    xp: perStarter + (isSGrade(starter.grade) ? share(MATCH_REWARDS.xp.sGrade, ghost) : 0),
  }));

  return {
    credits,
    lines,
    cardXp,
    xpTotal: cardXp.reduce((n, c) => n + c.xp, 0),
    ghost,
    creditsWithheld: !allowed,
  };
}

// --- the end of a season -----------------------------------------------------

/**
 * docs/01 section 5, last row: "Finish season 1st / 2nd / 3rd-4th / else — 1500 / 900 /
 * 500 / 250".
 *
 * The only row of that table that could not be wired until a league had a finish. It has
 * one now (shared/playoffs.ts, and the bracket it generates), so this is the arithmetic
 * and server/utils/seasonRewards.ts is the part that touches the ledger.
 *
 * `other` is deliberately not zero. A manager who played fourteen evenings and came sixth
 * has funded six packs' worth of someone else's season; sending them into the next one with
 * nothing is how a private league loses its sixth manager.
 */
export const SEASON_PLACING = {
  first: 1500,
  second: 900,
  /** Third and fourth — the beaten semi-finalists — are paid the same. */
  semiFinal: 500,
  other: 250,
} as const;

/** What a finishing position pays. Positions below fourth all pay the same. */
export function seasonPlacingCredits(placing: number): number {
  if (placing === 1) return SEASON_PLACING.first;
  if (placing === 2) return SEASON_PLACING.second;
  if (placing === 3 || placing === 4) return SEASON_PLACING.semiFinal;
  return SEASON_PLACING.other;
}

/** How a placing is written on a screen, and on the receipt the ledger stores. */
export function seasonPlacingLabel(placing: number): string {
  if (placing === 1) return 'Champion';
  if (placing === 2) return 'Runner-up';
  if (placing === 3) return 'Third place';
  if (placing === 4) return 'Fourth place';
  const t = placing % 100;
  const suffix = t >= 11 && t <= 13
    ? 'th'
    : (['th', 'st', 'nd', 'rd'][placing % 10] ?? 'th');
  return `Finished ${placing}${suffix}`;
}

export interface SeasonSettlement {
  memberId: string;
  placing: number;
  credits: number;
  label: string;
}

/**
 * What settling a season still owes.
 *
 * The first half of the idempotency story, and the half that can be read and tested. A
 * season can be settled more than once — both managers finishing the grand final in the
 * same instant, and the owner's repair button, all reach the same code — and docs/01
 * section 5 pays 1500 for winning a league, so paying it twice is not a rounding error.
 *
 * So: nothing is owed to a manager who already has a `season_rewards` row, nothing is owed
 * at all until the bracket is decided (which is why `placings` is empty before then — see
 * seasonPlacings in shared/playoffs.ts), and the same inputs always produce the same list.
 * Applying this to its own output's complement is a no-op, which is the property the test
 * checks and the property that matters.
 *
 * The second half cannot live here, because it is a race rather than a rule: two callers
 * can both read the same empty `season_rewards` and both be owed the same payout. That is
 * what the unique index on `(league_id, season, profile_id)` is for, and why
 * server/utils/seasonRewards.ts writes its claim row before it moves a single Credit.
 */
export function seasonSettlement(
  placings: Array<{ memberId: string; placing: number }>,
  alreadySettled: Iterable<string> = [],
): SeasonSettlement[] {
  const settled = new Set(alreadySettled);
  const seen = new Set<string>();
  const out: SeasonSettlement[] = [];

  for (const { memberId, placing } of placings) {
    // A member id twice in one list would otherwise be paid twice by a single pass, which
    // no index can catch because both writes are the same caller's.
    if (!memberId || settled.has(memberId) || seen.has(memberId)) continue;
    seen.add(memberId);

    out.push({
      memberId,
      placing,
      credits: seasonPlacingCredits(placing),
      label: seasonPlacingLabel(placing),
    });
  }

  return out;
}
