/**
 * The pack day.
 *
 * A LOM day starts at 17:00 local time, not at midnight: the league meets at a fixed hour
 * (docs/01-game-loop.md) and the pack is what you open when you sit down. So "today's pack"
 * means the window that opened at the most recent 17:00 in the league's timezone, and the
 * pack_day stored on the claim is the calendar date that window opened on.
 *
 * Everything here is server-side and timezone-explicit. The client never computes the
 * window — it is handed `nextOpensAt` as an instant and counts down to it, which is the
 * only way a user in Montreal and a user in Paris agree on when the pack drops.
 */

export interface PackWindow {
  /** The pack day key, 'YYYY-MM-DD' in the league timezone. */
  packDay: string;
  /** When the current window opened. */
  opensAt: Date;
  /** When the next one opens. */
  nextOpensAt: Date;
  hour: number;
  timeZone: string;
}

/** Offset of `tz` from UTC at this instant, in ms. */
function offsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // `hour` can come back as 24 for midnight in some runtimes.
  const hour = get('hour') % 24;
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asIfUtc - at.getTime();
}

/** The instant at which the wall clock in `tz` reads the given local date and hour. */
function zonedToUtc(year: number, month: number, day: number, hour: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour);
  // Two passes settles the DST boundary case, where the first offset is the wrong side of it.
  let ms = guess - offsetMs(new Date(guess), tz);
  ms = guess - offsetMs(new Date(ms), tz);
  return new Date(ms);
}

const pad = (n: number) => String(n).padStart(2, '0');

export function packWindow(now: Date = new Date(), hour = 17, timeZone = 'Europe/Paris'): PackWindow {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);

  const year = get('year');
  const month = get('month');
  const day = get('day');
  const localHour = get('hour') % 24;

  // Before the hour, the open window is still yesterday's.
  const openedOn = new Date(Date.UTC(year, month - 1, day));
  if (localHour < hour) openedOn.setUTCDate(openedOn.getUTCDate() - 1);

  const packDay = `${openedOn.getUTCFullYear()}-${pad(openedOn.getUTCMonth() + 1)}-${pad(openedOn.getUTCDate())}`;

  const opensAt = zonedToUtc(
    openedOn.getUTCFullYear(), openedOn.getUTCMonth() + 1, openedOn.getUTCDate(), hour, timeZone,
  );

  const nextDay = new Date(openedOn);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const nextOpensAt = zonedToUtc(
    nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), hour, timeZone,
  );

  return { packDay, opensAt, nextOpensAt, hour, timeZone };
}

/** Read the configured window straight from runtime config. */
export function configuredWindow(config: { packHour?: string | number; packTz?: string }, now = new Date()) {
  const hour = Number(config.packHour ?? 17);
  const tz = String(config.packTz || 'Europe/Paris');
  return packWindow(now, Number.isFinite(hour) ? hour : 17, tz);
}
