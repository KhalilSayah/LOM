/**
 * Leagues: the invite code, the calendar, and how a kick-off is written.
 *
 * All of it is needed on both sides. The client validates a typed invite code before
 * spending a round trip on it, and the launch route builds a season out of
 * `seasonSchedule` — but so does the lobby, which shows the owner what they are about
 * to commit everyone to *before* they press the button. A schedule you can preview is a
 * schedule that has to be computable without a database, so this module is pure: ids
 * in, pairings out, and any clock it needs is passed in.
 */

/** docs/01 section 2: 2 is minimal mode, 6 is the intended configuration. */
export const MIN_MANAGERS = 2;
export const MAX_MANAGERS = 6;

/**
 * How many leagues one manager can be in at once, counting only the ones still
 * forming or being played. A finished league is history, not a commitment, and
 * counting it would mean leaving a league you won just to host another.
 */
export const MAX_LIVE_LEAGUES = 8;

export const LEAGUE_CODE_LENGTH = 6;

/** A team name inside a league: what 0009 allows, minus surrounding space. */
export const TEAM_NAME_MAX = 24;

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

/**
 * A team name as typed, tidied — or null when there is nothing usable in it.
 * Inner runs of space collapse, because "  T1   Fanclub " is one name.
 */
export function cleanTeamName(raw: string | null | undefined): string | null {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, TEAM_NAME_MAX).trim();
  return text.length ? text : null;
}

// --- the calendar ------------------------------------------------------------

export type DraftSide = 'BLUE' | 'RED';

export interface Pairing {
  /**
   * The member who drafts first — or, on a Ghost pairing, the one manager in it,
   * whichever side they draft from. `league_fixtures` keeps a Ghost's manager in
   * `blue_member_id` (a constraint since 0009), so the side lives in `ghostSide`.
   */
  blue: string;
  /** Null means a Ghost: an odd league leaves somebody unpaired every round. */
  red: string | null;
  /**
   * Which side the Ghost drafts from, on a Ghost pairing only. 'RED' means the
   * manager has first pick; 'BLUE' means the Ghost does (migration 0016).
   */
  ghostSide?: DraftSide;
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
 * join order. The Ghost alternates by round for the same reason: it used to be red
 * every time, in both cycles, so a bye was always a free first pick.
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
        day.push({ blue: (a ?? b)!, red: null, ghostSide: r % 2 === 0 ? 'RED' : 'BLUE' });
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

/** The second cycle's version of a pairing: the other side of the draft, Ghosts included. */
const swapped = (p: Pairing): Pairing => (p.red
  ? { blue: p.red, red: p.blue }
  : { blue: p.blue, red: null, ghostSide: p.ghostSide === 'BLUE' ? 'RED' : 'BLUE' });

/**
 * The whole regular season, day by day, as pairings.
 *
 * Two cycles with the sides reversed is the docs/01 shape: you play everyone once,
 * then everyone again from the other side of the draft. Smaller leagues repeat that
 * pair of cycles until the season is about `MATCH_DAY_TARGET` evenings long.
 *
 * The length is decided by the number of managers and nothing else. It used to take
 * a "season length" and cut the calendar at it, which meant a short setting quietly
 * broke the one promise the lobby makes — everyone against everyone twice — so the
 * setting is gone and the length is whatever keeps that promise (see `seasonShape`).
 *
 * Playoffs are not here. They need standings, and standings need matches that have
 * actually been played, so the bracket is generated at the end of the regular
 * season rather than guessed at launch — see docs/01 section 3.
 */
export function seasonSchedule(ids: string[]): ScheduleDay[] {
  if (ids.length < MIN_MANAGERS) {
    throw new Error(`A league needs at least ${MIN_MANAGERS} managers.`);
  }
  if (ids.length > MAX_MANAGERS) {
    throw new Error(`A league holds at most ${MAX_MANAGERS} managers.`);
  }

  const first = roundRobin(ids);
  const second = first.map((day) => day.map(swapped));

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

  return days;
}

/** Match days only — what "10 match days" in the lobby is counting. */
export const matchDayCount = (days: ScheduleDay[]) => days.filter((d) => !d.rest).length;

export interface SeasonShape {
  managers: number;
  /** Evenings with a regular fixture on them. */
  matchDays: number;
  restDays: number;
  /** Match days plus rest days: the regular season, end to end. */
  regularDays: number;
  /** Semis, the day off, the final — or just the final, for two. */
  playoffDays: number;
  totalDays: number;
  /** How many times each pair meets in the regular season. */
  meetings: number;
}

/**
 * How long a season is for a league of this size, in the numbers the lobby shows.
 *
 * This is what replaced the season-length setting. The playoff gaps are the ones
 * server/utils/leaguePlayoffs.ts uses (semis the day after, a rest day, the final;
 * a league of two plays the final the day after), kept in step by hand because that
 * module holds the database and this one cannot import it.
 */
export function seasonShape(managers: number): SeasonShape {
  const n = Math.min(MAX_MANAGERS, Math.max(MIN_MANAGERS, Math.round(managers) || MIN_MANAGERS));
  const days = seasonSchedule(Array.from({ length: n }, (_, i) => `m${i}`));
  const matchDays = matchDayCount(days);
  const playoffDays = n >= 3 ? 3 : 1;
  // Rounds in one round robin: n - 1 for an even league, n for an odd one (the Ghost seat).
  const rounds = n % 2 === 0 ? n - 1 : n;

  return {
    managers: n,
    matchDays,
    restDays: days.length - matchDays,
    regularDays: days.length,
    playoffDays,
    totalDays: days.length + playoffDays,
    meetings: Math.round(matchDays / rounds),
  };
}

// --- playing a fixture -------------------------------------------------------

/**
 * docs/01 section 4: the lobby opens at `M - 15 min`.
 *
 * Before that the fixture is something you can read; after it, something you can
 * open. Fifteen minutes is enough for the first person there to notice nobody else
 * is, and short enough that it is still the same evening.
 */
export const FIXTURE_LOBBY_LEAD_SECONDS = 15 * 60;

/**
 * How long after kick-off a fixture nobody opened is played for both of them.
 *
 * docs/01 section 8: standings cannot be held hostage by somebody who will not open
 * the app. A day is long enough that a missed evening can still be played by hand the
 * next one, and short enough that the table never stalls for longer than that.
 */
export const FIXTURE_AUTOPLAY_AFTER_SECONDS = 24 * 3600;

/**
 * When both managers are in the lobby and ready before kick-off, the draft starts
 * this long after the second of them says so — enough to finish walking into the room.
 */
export const EARLY_START_LEAD_SECONDS = 10;

export interface FixtureWindow {
  /** When the room can first be opened. */
  opensAt: number;
  open: boolean;
  /** Seconds until it opens; 0 once it has. */
  secondsUntil: number;
  /** The kick-off itself: the draft's first clock starts here, not when somebody opens the room. */
  kickOffAt: number;
  /** True once kick-off has passed. */
  started: boolean;
  /** When a fixture nobody opened is played automatically, for both sides. */
  autoPlayAt: number;
  /** True once that moment has passed. */
  overdue: boolean;
}

/**
 * Whether a fixture can be played yet, from its kick-off.
 *
 * Opening the room is allowed from 15 minutes before kick-off, but the draft does not
 * start until kick-off (server/utils/leagueFixture.ts) — the first manager in no longer
 * starts the clock on somebody who is still on their way. Late is still allowed: a
 * league of friends misses evenings, and a fixture played the morning after is a better
 * game than a forfeit nobody chose. Past `autoPlayAt` the agent plays it for both.
 */
export function fixtureWindow(
  scheduledAt: string | null,
  now: number = Date.now(),
): FixtureWindow {
  if (!scheduledAt) {
    return {
      opensAt: 0, open: false, secondsUntil: 0,
      kickOffAt: 0, started: false, autoPlayAt: 0, overdue: false,
    };
  }

  const kickOffAt = new Date(scheduledAt).getTime();
  const opensAt = kickOffAt - FIXTURE_LOBBY_LEAD_SECONDS * 1000;
  const autoPlayAt = kickOffAt + FIXTURE_AUTOPLAY_AFTER_SECONDS * 1000;
  const remaining = Math.max(0, Math.ceil((opensAt - now) / 1000));

  return {
    opensAt,
    open: remaining === 0,
    secondsUntil: remaining,
    kickOffAt,
    started: now >= kickOffAt,
    autoPlayAt,
    overdue: now >= autoPlayAt,
  };
}

// --- telling the time --------------------------------------------------------

/*
 * One way of writing a kick-off, everywhere.
 *
 * The league list used to say "tonight 12:09 PM" — a 12-hour clock beside a match
 * hour typed as 20:30, and "tonight" at noon. These are the rules now, and they live
 * here so the list, the league screen and the calendar cannot drift apart:
 *
 *   - 24-hour clock, because that is how the match hour is set.
 *   - "Today", "Tomorrow", "Yesterday", then a weekday for the rest of this week, then
 *     a short date. Never "tonight": a fixture at 12:30 is not one.
 *   - The viewer's own clock, with the league's alongside it when the two disagree —
 *     a manager in Montréal in a Paris league should not be doing arithmetic.
 *
 * Pure: the instant, the clock and both zones come in as arguments, so the server and
 * the client agree, and the tests do not depend on where they run.
 */

const TIME_LOCALE = 'en-GB';

const safeZone = (tz: string | null | undefined): string | undefined => {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat(TIME_LOCALE, { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
};

/** The runtime's zone, or undefined where it has none. */
export function runtimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** 'YYYY-MM-DD' for an instant, on the wall calendar of `tz` (the runtime's if absent). */
export function ymdIn(at: Date | number | string, tz?: string | null): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeZone(tz), year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** '20:30' for an instant, on the wall clock of `tz`. */
export function clockIn(at: Date | number | string, tz?: string | null): string {
  return new Intl.DateTimeFormat(TIME_LOCALE, {
    timeZone: safeZone(tz), hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(at));
}

/** Whole days from `a` to `b`, both 'YYYY-MM-DD'. */
export function dayGap(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / 86400000);
}

/**
 * A calendar date as a person reads it: 'Sat 21 Nov', with the year only when it is
 * not this one. For date-only values like `starts_on`, which are already local dates
 * and must not be shifted through anybody's timezone.
 */
export function dateLabel(ymd: string | null | undefined, now: number = Date.now()): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return '';
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  const at = new Date(Date.UTC(y!, m! - 1, d!, 12));
  const sameYear = y === new Date(now).getUTCFullYear();
  return new Intl.DateTimeFormat(TIME_LOCALE, {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(at).replace(/,/g, '');
}

/** "Today" / "Tomorrow" / "Yesterday" / "Thursday" / "Sat 28 Nov", for an instant. */
export function dayWord(
  at: Date | number | string,
  now: number = Date.now(),
  tz?: string | null,
): string {
  const instant = new Date(at);
  const day = ymdIn(instant, tz);
  const gap = dayGap(ymdIn(now, tz), day);

  if (gap === 0) return 'Today';
  if (gap === 1) return 'Tomorrow';
  if (gap === -1) return 'Yesterday';
  if (gap > 1 && gap < 7) {
    return new Intl.DateTimeFormat(TIME_LOCALE, { timeZone: safeZone(tz), weekday: 'long' }).format(instant);
  }
  return dateLabel(day, now);
}

/** The last part of an IANA zone, as people say it: 'America/New_York' -> 'New York'. */
export const zoneCity = (tz: string | null | undefined) =>
  String(tz || '').split('/').pop()!.replace(/_/g, ' ');

/** True when a wall clock in `a` and one in `b` read differently at this instant. */
export function zonesDiffer(at: Date | number | string, a?: string | null, b?: string | null): boolean {
  if (!a || !b || a === b) return false;
  return clockIn(at, a) !== clockIn(at, b) || ymdIn(at, a) !== ymdIn(at, b);
}

export interface KickOffText {
  /** 'Today 20:30', in the viewer's zone. */
  text: string;
  /** '20:30 Paris time', when the league's zone reads differently; '' otherwise. */
  league: string;
}

/**
 * A kick-off, written the one way the app writes it.
 *
 * `viewerTz` defaults to the runtime's own zone, which on a phone is the phone's. The
 * league's reading is added only when it differs, so most people in most leagues just
 * see 'Today 20:30'.
 */
export function kickOffText(
  iso: string | null | undefined,
  opts: { now?: number; viewerTz?: string | null; leagueTz?: string | null } = {},
): KickOffText {
  if (!iso) return { text: '', league: '' };
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { text: '', league: '' };

  const now = opts.now ?? Date.now();
  const viewer = opts.viewerTz || runtimeZone();
  const text = `${dayWord(at, now, viewer)} ${clockIn(at, viewer)}`;

  const league = opts.leagueTz && zonesDiffer(at, viewer, opts.leagueTz)
    ? `${clockIn(at, opts.leagueTz)} ${zoneCity(opts.leagueTz)} time`
    : '';

  return { text, league };
}

/** A whole kick-off on one line: 'Today 14:30 (20:30 Paris time)'. */
export function kickOffLine(
  iso: string | null | undefined,
  opts: { now?: number; viewerTz?: string | null; leagueTz?: string | null } = {},
): string {
  const { text, league } = kickOffText(iso, opts);
  return league ? `${text} (${league})` : text;
}
