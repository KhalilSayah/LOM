/**
 * A manager's names, and the rules for them, on both sides of the wire.
 *
 * - The handle is the unique one: what a share link, a league table and a duel say when
 *   they need to tell two people apart. 3 to 20 letters, digits or underscores, stored in
 *   lower case (the column's check in 0001 enforces the same shape).
 * - The display name is what people see first. Optional; falls back to the handle.
 * - The team name is the default a league seat is given. Optional; falls back to the
 *   display name. Same 24-character limit as league_members.team_name.
 *
 * The client checks these before spending a round trip; the server checks them again
 * because the client is not the only thing that can call it.
 */

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;
export const DISPLAY_MAX = 24;
export const TEAM_MAX = 24;

const HANDLE = /^[a-z0-9_]{3,20}$/;

/** Names that would read as the game speaking rather than a player. */
const RESERVED = new Set([
  'admin', 'administrator', 'agent', 'theagent', 'bot', 'lom', 'moderator', 'mod',
  'official', 'riot', 'staff', 'support', 'system', 'root', 'null', 'undefined', 'manager',
]);

export function normaliseHandle(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/^@/, '').toLowerCase() : '';
}

/** Null when the handle is fine, otherwise a sentence saying what is wrong with it. */
export function handleProblem(handle: string): string | null {
  if (handle.length < HANDLE_MIN) return `At least ${HANDLE_MIN} characters.`;
  if (handle.length > HANDLE_MAX) return `${HANDLE_MAX} characters at most.`;
  if (!HANDLE.test(handle)) return 'Letters, numbers and underscores only.';
  if (RESERVED.has(handle)) return 'That name is reserved. Pick another.';
  return null;
}

/** Trims, collapses inner whitespace and drops control characters. */
export function cleanName(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
