/**
 * Leagues: the invite code, and the calendar.
 *
 * Both halves are here because both are needed on both sides. The client validates
 * a typed invite code before spending a round trip on it, and the launch route
 * builds a season out of `seasonSchedule` — but so does the lobby, which shows the
 * owner what they are about to commit everyone to *before* they press the button.
 * A schedule you can preview is a schedule that has to be computable without a
 * database, so this module is pure: ids in, pairings out, no clock and no I/O.
 */

/** docs/01 section 2: 2 is minimal mode, 6 is the intended configuration. */
export const MIN_MANAGERS = 2;
export const MAX_MANAGERS = 6;

export const LEAGUE_CODE_LENGTH = 6;

/** The same Crockford base32 as a share code (supabase/migrations/0002), at six. */
const VALID_CODE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;

/**
 * What someone typed, as an invite code — or null if it is not one.
 *
 * Accepts `h7k-2m4`, `lom-H7K2M4`, `H7K 2M4` and a whole invite URL pasted in, since
 * what gets sent to a group chat is a link and what comes back is whatever part of it
 * the other person managed to select. The lookalikes are mapped the same way as in
 * shared/shareCode.ts: O is a zero, I and L are ones, and a U is a genuine mistake.
 */
export function normaliseLeagueCode(raw: string | null | undefined): string | null {
  const text = String(raw ?? '');
  // A pasted link: take the last path segment, which is where /join/<code> puts it.
  const tail = text.includes('/') ? text.split(/[?#]/)[0]!.split('/').filter(Boolean).pop() ?? '' : text;

  const cleaned = tail
    .toUpperCase()
    .replace(/^LOM[-\s_]*/, '')
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');

  return VALID_CODE.test(cleaned) ? cleaned : null;
}

/** How a code is shown: one group, because six characters read fine in one. */
export const formatLeagueCode = (code: string | null | undefined) =>
  String(code ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');

// --- the calendar ------------------------------------------------------------

export interface Pairing {
  /** The member who drafts first. */
  blue: string;
  /** Null means a Ghost: an odd league leaves somebody unpaired every round. */
  red: string | null;
}

export interface ScheduleDay {
  dayIndex: number;
  /** A rest day has no fixtures at all. The pack still drops. */
  rest: boolean;
  pairings: Pairing[];
}

/**
 * How many evenings of actual matches a season aims for.
 *
 * docs/01 section 3 sizes the intended league — 6 managers, double round robin — at
 * 10 match days, and that number is what makes the rest of the calendar work: one
 * rest day in the middle, then the playoff days. Smaller leagues play the same
 * number of evenings by going round more often, rather than finishing in a week and
 * leaving everyone with nothing to open the app for.
 */
const MATCH_DAY_TARGET = 10;

/** docs/01 section 3: one rest day per five match days. */
const REST_EVERY = 5;

/**
 * One round robin, by the circle method: every manager meets every other once.
 *
 * An odd number of managers gets a null added to the circle, and whoever is paired
 * with it that round plays a Ghost instead of sitting out.
 *
 * Sides alternate within a round as well as between cycles. Without the `(r + i)`
 * term the manager who happens to be first in the list draws blue in every single
 * fixture of cycle 1, which is a real advantage — blue picks first — handed out by
 * join order.
 */
export function roundRobin(ids: string[]): Pairing[][] {
  const circle: (string | null)[] = [...ids];
  if (circle.length % 2 === 1) circle.push(null);

  const n = circle.length;
  const out: Pairing[][] = [];

  for (let r = 0; r < n - 1; r++) {
    const day: Pairing[] = [];

    for (let i = 0; i < n / 2; i++) {
      const a = circle[i] ?? null;
      const b = circle[n - 1 - i] ?? null;
      if (a === null && b === null) continue;

      if (a === null || b === null) {
        day.push({ blue: (a ?? b)!, red: null });
      } else {
        day.push((r + i) % 2 === 0 ? { blue: a, red: b } : { blue: b, red: a });
      }
    }

    out.push(day);
    // Rotate every seat but the first. This is the circle method; the fixed seat is
    // what stops the rotation from reproducing the same pairings next round.
    circle.splice(1, 0, circle.pop()!);
  }

  return out;
}

/**
 * The whole season, day by day, as pairings.
 *
 * Two cycles with the sides reversed is the docs/01 shape: you play everyone once,
 * then everyone again from the other side of the draft. Smaller leagues repeat that
 * pair of cycles until the season is about `MATCH_DAY_TARGET` evenings long.
 *
 * Playoffs are not here. They need standings, and standings need matches that have
 * actually been played, so the bracket is generated at the end of the regular
 * season rather than guessed at launch — see docs/01 section 3.
 */
export function seasonSchedule(ids: string[], seasonLengthDays = 14): ScheduleDay[] {
  if (ids.length < MIN_MANAGERS) {
    throw new Error(`A league needs at least ${MIN_MANAGERS} managers.`);
  }
  if (ids.length > MAX_MANAGERS) {
    throw new Error(`A league holds at most ${MAX_MANAGERS} managers.`);
  }

  const first = roundRobin(ids);
  const second = first.map((day) =>
    day.map((p) => (p.red ? { blue: p.red, red: p.blue } : p)));

  const cycle = [...first, ...second];
  const repeats = Math.max(1, Math.round(MATCH_DAY_TARGET / cycle.length));

  const matchDays: Pairing[][] = [];
  for (let n = 0; n < repeats; n++) matchDays.push(...cycle);

  const days: ScheduleDay[] = [];
  matchDays.forEach((pairings, i) => {
    days.push({ dayIndex: days.length + 1, rest: false, pairings });
    const played = i + 1;
    // Never a trailing rest day: a season ends on a match.
    if (played % REST_EVERY === 0 && played < matchDays.length) {
      days.push({ dayIndex: days.length + 1, rest: true, pairings: [] });
    }
  });

  const capped = days.slice(0, Math.max(1, seasonLengthDays));
  while (capped.length > 1 && capped[capped.length - 1]!.rest) capped.pop();

  return capped;
}

/** Match days only — what "10 match days" in the lobby is counting. */
export const matchDayCount = (days: ScheduleDay[]) => days.filter((d) => !d.rest).length;

// --- playing a fixture -------------------------------------------------------

/**
 * docs/01 section 4: the lobby opens at `M - 15 min`.
 *
 * Before that the fixture is something you can read; after it, something you can
 * open. Fifteen minutes is enough for the first person there to notice nobody else
 * is, and short enough that it is still the same evening.
 */
export const FIXTURE_LOBBY_LEAD_SECONDS = 15 * 60;

export interface FixtureWindow {
  /** When the room can first be opened. */
  opensAt: number;
  open: boolean;
  /** Seconds until it opens; 0 once it has. */
  secondsUntil: number;
}

/**
 * Whether a fixture can be played yet, from its kick-off.
 *
 * There is deliberately no upper bound. A league of friends misses evenings, and a
 * fixture that locks itself at midnight turns a missed evening into a result nobody
 * played. Late is a worse game than on time; it is a much better game than a forfeit
 * nobody chose. (A real forfeit — docs/05 section 7 — needs the absence handling that
 * does not exist yet.)
 */
export function fixtureWindow(
  scheduledAt: string | null,
  now: number = Date.now(),
): FixtureWindow {
  if (!scheduledAt) return { opensAt: 0, open: false, secondsUntil: 0 };

  const opensAt = new Date(scheduledAt).getTime() - FIXTURE_LOBBY_LEAD_SECONDS * 1000;
  const remaining = Math.max(0, Math.ceil((opensAt - now) / 1000));

  return { opensAt, open: remaining === 0, secondsUntil: remaining };
}
