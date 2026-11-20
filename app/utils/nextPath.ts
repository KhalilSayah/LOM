/**
 * Where to go after signing in.
 *
 * An invite link is the one URL in this app that gets sent to somebody who has no
 * account yet, so "every route is the door" (app/middleware/auth.global.ts) cannot
 * simply forget where they were going — they tap a link to a league, sign up, and
 * must land on the invite rather than on the pack screen wondering what happened.
 *
 * Which makes this a redirect taken from a query string, so it is also the one place
 * an open redirect could get in. Only a path on this origin is allowed through:
 * anything starting with a second slash or a backslash is a URL somewhere else
 * dressed as a path, and `//evil.example` is a perfectly valid one.
 */
export function safeNext(raw: unknown, fallback = '/pack'): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const path = typeof value === 'string' ? value.trim() : '';

  if (!path.startsWith('/')) return fallback;
  if (path.startsWith('//') || path.startsWith('/\\')) return fallback;
  // The door itself, and the confirm screen, would bounce straight back here.
  if (path === '/' || path.startsWith('/confirm')) return fallback;

  return path;
}
