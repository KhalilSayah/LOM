/**
 * The end of a season: a bracket, a champion, and where everybody finished.
 *
 * docs/01 section 3 draws the intended shape — "day 12 semi-finals, seeds 1v4 and 2v3,
 * day 14 final" — and docs/01 section 7 says what happens when the final is decided.
 * This module is the whole of that as arithmetic: seeds in, matches out, results in,
 * placings out. No database, no clock.
 *
 * Pure for the same reason shared/standings.ts is pure. A bracket is the other thing a
 * league argues about, and "why am I playing the fourth seed" has to be answerable by
 * reading something rather than by trusting a SQL ORDER BY nobody can see. It is also
 * what lets the league screen draw the bracket before the semis have been played: the
 * rows that do not exist yet are still computable.
 *
 * The seeding itself is not here. It is the final regular-season table, which
 * shared/standings.ts already computes with every tiebreak in docs/01 section 3 —
 * including the coin seeded from the league id, so a drawn table seeds the same bracket
 * every time it is drawn. This module takes that order as given.
 */

/** docs/01 section 3: a top-four bracket. Smaller leagues get less of it (see `bracketFor`). */
export const PLAYOFF_SIZE = 4;

/**
 * A slot in the bracket, not a fixture id.
 *
 * Stable across every league, which is what lets a result be matched to a slot without
 * the caller having to remember the order rows were inserted in.
 */
export type BracketKey = 'SF1' | 'SF2' | 'FINAL';

/**
 * The two playoff stages, as they are stored on `league_fixtures.stage`.
 *
 * `GRAND_FINAL` rather than `FINAL` deliberately: a fixture already has
 * `status = 'FINAL'` meaning "this match has been decided", and a stage called FINAL
 * beside it would make every read of either column a guess about which one was meant.
 */
export type PlayoffStage = 'SEMI' | 'GRAND_FINAL';

export interface BracketMatch {
  key: BracketKey;
  stage: PlayoffStage;
  /**
   * The 1-based regular-season seed on each side, or null when the side is whoever
   * wins an earlier match. Exactly one of `seed` and `from` is set per side.
   */
  blueSeed: number | null;
  redSeed: number | null;
  /** The match this side's winner arrives from. */
  blueFrom: BracketKey | null;
  redFrom: BracketKey | null;
}

export interface Bracket {
  /**
   * The members who made the cut, best seed first. Seed n is `seeds[n - 1]`.
   * Two, three or four of them — see `bracketFor`.
   */
  seeds: string[];
  /** Semis first, the final last. A 2-manager league has only the final. */
  matches: BracketMatch[];
  /** Everyone who missed the cut, in table order, so their placings can still be paid. */
  missed: string[];
}

export interface BracketResult {
  key: BracketKey;
  /** Null while the match has not been decided. */
  winnerMemberId: string | null;
}

export interface MatchSides {
  blue: string | null;
  red: string | null;
}

export interface BracketState {
  /** Sides per match, resolved as far as the results so far allow. */
  sides: Record<BracketKey, MatchSides>;
  championMemberId: string | null;
  runnerUpMemberId: string | null;
  /** The managers who lost a semi, better seed first. Third and fourth. */
  semiLosers: string[];
  /** True once the final has a winner. Nothing is paid before this. */
  decided: boolean;
}

export interface Placing {
  memberId: string;
  /** 1 champion, 2 runner-up, 3 and 4 the beaten semi-finalists, then table order. */
  placing: number;
}

/**
 * The bracket a finished regular season produces.
 *
 * `order` is the final table, best first — `standings()` output, mapped to member ids.
 *
 * The three sizes are not three designs, they are one design with the byes a small field
 * forces. docs/01 section 2 allows a league of two and calls it minimal mode, so the
 * degenerate cases have to be real answers rather than a crash:
 *
 *   4 or more — the top four. Semis 1v4 and 2v3, as docs/01 section 3 draws it. Seeds 5
 *               and 6 are out; the exhibition matches that section mentions for them are
 *               still an open question (section 9) and are not generated here.
 *   3         — the top seed byes straight to the final and 2 plays 3 for the right to
 *               meet them. A four-slot bracket with an empty seat would be a semi-final
 *               somebody wins by walking, which is worse than a bye they earned.
 *   2         — no semis at all; the final is simply 1 v 2. They have played each other
 *               all season, so the bracket's only job is to make the last one matter.
 *
 * The higher seed takes blue in every match it can be decided for. Blue drafts first
 * (docs/05), which is a real advantage, and topping the table is the only honest way to
 * hand it out — the regular season reversed sides every cycle precisely so that this is
 * the one place in the calendar where it is earned rather than assigned.
 */
export function bracketFor(order: string[]): Bracket {
  const unique = order.filter((id, i) => id && order.indexOf(id) === i);

  if (unique.length < 2) {
    throw new Error('A playoff bracket needs at least two managers.');
  }

  const seeds = unique.slice(0, PLAYOFF_SIZE);
  const missed = unique.slice(PLAYOFF_SIZE);

  const matches: BracketMatch[] = [];

  if (seeds.length >= 4) {
    matches.push(
      { key: 'SF1', stage: 'SEMI', blueSeed: 1, redSeed: 4, blueFrom: null, redFrom: null },
      { key: 'SF2', stage: 'SEMI', blueSeed: 2, redSeed: 3, blueFrom: null, redFrom: null },
      {
        key: 'FINAL',
        stage: 'GRAND_FINAL',
        blueSeed: null,
        redSeed: null,
        blueFrom: 'SF1',
        redFrom: 'SF2',
      },
    );
  } else if (seeds.length === 3) {
    matches.push(
      { key: 'SF1', stage: 'SEMI', blueSeed: 2, redSeed: 3, blueFrom: null, redFrom: null },
      {
        key: 'FINAL',
        stage: 'GRAND_FINAL',
        // The bye. The top seed is in the final before the semi is played, which is
        // what the bye is for, so this side is known from the moment the bracket exists.
        blueSeed: 1,
        redSeed: null,
        blueFrom: null,
        redFrom: 'SF1',
      },
    );
  } else {
    matches.push({
      key: 'FINAL',
      stage: 'GRAND_FINAL',
      blueSeed: 1,
      redSeed: 2,
      blueFrom: null,
      redFrom: null,
    });
  }

  return { seeds, matches, missed };
}

/** The member holding a given seed, or null if the bracket is smaller than that. */
const atSeed = (bracket: Bracket, seed: number | null): string | null =>
  (seed && seed >= 1 && seed <= bracket.seeds.length ? bracket.seeds[seed - 1]! : null);

/** 1-based seed of a member, or `Infinity` for somebody who is not in the bracket. */
export const seedOf = (bracket: Bracket, memberId: string | null): number => {
  const i = memberId ? bracket.seeds.indexOf(memberId) : -1;
  return i < 0 ? Infinity : i + 1;
};

/**
 * Where the bracket stands, given whatever has been decided so far.
 *
 * Idempotent and total: called with no results it answers the sides that are known from
 * seeding alone, which is exactly what the league screen needs to draw an empty bracket.
 * Called with every result it answers the champion. Nothing in between is a special case.
 */
export function bracketState(bracket: Bracket, results: BracketResult[]): BracketState {
  const winner = new Map<BracketKey, string | null>();
  for (const r of results) {
    // Last writer wins, which only matters if a caller passes the same key twice.
    winner.set(r.key, r.winnerMemberId || null);
  }

  const sides = {} as Record<BracketKey, MatchSides>;

  for (const match of bracket.matches) {
    const from = (key: BracketKey | null) => (key ? winner.get(key) ?? null : null);

    let blue = atSeed(bracket, match.blueSeed) ?? from(match.blueFrom);
    let red = atSeed(bracket, match.redSeed) ?? from(match.redFrom);

    /**
     * The final's sides, once both finalists are known, are ordered by seed rather than
     * by which semi they came out of. A fourth seed that beats the first should not also
     * inherit first pick in the final from the slot it won; the better seed still drafts
     * first, which is the same rule the semis use.
     */
    if (match.stage === 'GRAND_FINAL' && blue && red && seedOf(bracket, red) < seedOf(bracket, blue)) {
      [blue, red] = [red, blue];
    }

    sides[match.key] = { blue, red };
  }

  const championMemberId = winner.get('FINAL') ?? null;

  const finalSides = sides.FINAL ?? { blue: null, red: null };
  const runnerUpMemberId = championMemberId
    ? [finalSides.blue, finalSides.red].find((id) => id && id !== championMemberId) ?? null
    : null;

  /**
   * Third and fourth: whoever lost a semi, best seed first.
   *
   * Read off the semis rather than by subtracting the finalists from the seeds, because
   * in a 3-manager bracket the top seed never played a semi and is not a semi loser even
   * if they lose the final — they are second, and the one beaten semi-finalist is third.
   */
  const semiLosers = bracket.matches
    .filter((m) => m.stage === 'SEMI')
    .map((m) => {
      const w = winner.get(m.key) ?? null;
      if (!w) return null;
      const { blue, red } = sides[m.key]!;
      return [blue, red].find((id) => id && id !== w) ?? null;
    })
    .filter((id): id is string => Boolean(id))
    .sort((a, b) => seedOf(bracket, a) - seedOf(bracket, b));

  return {
    sides,
    championMemberId,
    runnerUpMemberId,
    semiLosers,
    decided: Boolean(championMemberId),
  };
}

/**
 * Where everyone finished, once the final has been played.
 *
 * Empty until the bracket is decided, on purpose: this is what the season payout is
 * computed from, and a half-finished bracket must not be able to pay a half-finished
 * placing. docs/01 section 5 pays 1st / 2nd / 3rd-4th / else, so the only distinctions
 * that have to be right are the top two, the semi losers as a pair, and everybody else.
 *
 * Everybody else keeps their regular-season order. They did not play a playoff match, so
 * there is nothing else to separate them by, and the table they finished in is the fairest
 * thing on hand.
 */
export function seasonPlacings(bracket: Bracket, state: BracketState): Placing[] {
  if (!state.decided || !state.championMemberId) return [];

  const out: Placing[] = [{ memberId: state.championMemberId, placing: 1 }];
  if (state.runnerUpMemberId) out.push({ memberId: state.runnerUpMemberId, placing: 2 });

  for (const memberId of state.semiLosers) {
    out.push({ memberId, placing: out.length + 1 });
  }

  /**
   * A 3-manager bracket where the bye loses the final: the top seed is second, the semi
   * winner it beat is... already counted, and the semi loser is third. Nothing to patch.
   * But a seeded member can still be missing from the three lists above if a semi has no
   * recorded winner while the final somehow does, so the seeds are swept before `missed`
   * to make sure the placings cover the whole league either way.
   */
  const placed = new Set(out.map((p) => p.memberId));

  for (const memberId of [...bracket.seeds, ...bracket.missed]) {
    if (placed.has(memberId)) continue;
    placed.add(memberId);
    out.push({ memberId, placing: out.length + 1 });
  }

  return out;
}

// --- reading a bracket back --------------------------------------------------

export interface BracketSlot {
  key: BracketKey;
  blue: string | null;
  red: string | null;
}

/**
 * The bracket that produced these slots.
 *
 * The inverse of `bracketFor`, and the reason the stored fixtures are the record of a
 * bracket rather than a hint about one. Once the semis exist, the seeding is written
 * down in them: SF1 is 1v4 and SF2 is 2v3, by construction, so four rows of member ids
 * are four seeds. Rebuilding the seeding by recomputing the table instead would make
 * every later read of the bracket depend on the standings coming out the same way
 * twice — true today, and not something the end of a season should rest on.
 *
 * `rest` is everyone who missed the cut, in table order. It only orders the placings
 * below fourth, which docs/01 section 5 pays identically, so it is the one part of a
 * finished bracket that is safe to take from the live table.
 */
export function bracketFromSlots(slots: BracketSlot[], rest: string[] = []): Bracket {
  const slot = (key: BracketKey) => slots.find((s) => s.key === key) ?? null;

  const sf1 = slot('SF1');
  const sf2 = slot('SF2');
  const final = slot('FINAL');

  let seeds: (string | null)[];

  if (sf1 && sf2) {
    // Four seeds, read straight off the two semis.
    seeds = [sf1.blue, sf2.blue, sf2.red, sf1.red];
  } else if (sf1) {
    // Three: the bye is the final's blue side, which it holds as the better seed
    // whatever comes out of the semi, so it is stable to read back.
    seeds = [final?.blue ?? null, sf1.blue, sf1.red];
  } else {
    seeds = [final?.blue ?? null, final?.red ?? null];
  }

  const present = seeds.filter((id): id is string => Boolean(id));

  if (present.length < 2) {
    throw new Error('Those fixtures are not a playoff bracket.');
  }

  const seeded = new Set(present);

  // The match shapes come from the seed count, which is the same number they were
  // generated from — so this is the same bracket, not a new one that happens to agree.
  return {
    seeds: present,
    matches: bracketFor(present).matches,
    missed: rest.filter((id) => !seeded.has(id)),
  };
}
