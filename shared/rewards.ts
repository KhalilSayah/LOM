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
