/**
 * The manager share code, in one place.
 *
 * Eight characters of Crockford base32 — 0-9 and A-Z without I, L, O and U. The
 * database mints them (supabase/migrations/0002_discovery.sql); this module is the
 * only thing that decides whether what someone typed is one of them.
 *
 * Normalising matters more than it looks. A code gets read off a phone screen, said
 * out loud, pasted with the display dash still in it, or typed in lower case. All of
 * those should resolve to the same eight characters, and the three lookalike pairs
 * Crockford excludes are exactly the ones that get mistyped: O for 0, I and L for 1.
 * Mapping them on input means a correct code is never rejected for a reason the
 * person cannot see.
 *
 * U is excluded from the alphabet and deliberately not mapped: no code contains one,
 * so a U is a genuinely wrong character, and quietly turning it into a V would send
 * the lookup to some other manager.
 */

export const SHARE_CODE_LENGTH = 8;

/** Codes are stored and compared in this form: eight characters, no separator. */
const VALID = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;

/**
 * What someone typed, as a code — or null if it is not one.
 * Accepts `7k2m-4qxp`, `7K2M 4QXP`, `LOM-7K2M4QXP` and `7KZM4QXP`.
 */
export function normaliseShareCode(raw: string | null | undefined): string | null {
  const cleaned = String(raw ?? '')
    .toUpperCase()
    .replace(/^LOM[-\s_]*/, '')
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');

  return VALID.test(cleaned) ? cleaned : null;
}

/** How a code is shown: grouped in fours, which is how people read it back. */
export function formatShareCode(code: string | null | undefined): string {
  const raw = String(code ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (raw.length !== SHARE_CODE_LENGTH) return raw;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
