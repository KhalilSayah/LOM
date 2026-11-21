import { serverSupabaseServiceRole } from '#supabase/server';
import { allowHit, clientAddress, tooMany } from '~~/server/utils/rateLimit';

/**
 * Create an account that is already confirmed.
 *
 * Supabase's client-side `signUp` sends a confirmation mail unless the project has
 * "Confirm email" switched off in the dashboard. That toggle is reachable only through the
 * Management API, so an app cannot turn it off for itself, and the built-in SMTP allows a
 * few messages an hour — which means testing signup twice ends in `email rate limit
 * exceeded` and a half-made account.
 *
 * The admin API can create the user outright with `email_confirm: true`. No mail is sent
 * and the dashboard setting stops mattering. The client then signs in with the password it
 * already has.
 *
 * What this endpoint is allowed to do is deliberately narrow: create a user with an email
 * and a password, nothing else. It never reads the request for a role, a profile field or
 * an id, because it holds the service-role key and anything it accepts from the body is
 * something a stranger can set.
 *
 * Because it skips Supabase's own sign-up throttling, it carries its own: a handful of
 * accounts per address and per email in a window (server/utils/rateLimit.ts). Errors are
 * written for the person at the door; whatever the auth server actually said goes to the
 * log, never to the response.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const PER_IP = { limit: 5, windowMs: 15 * 60_000 };
const PER_EMAIL = { limit: 3, windowMs: 60 * 60_000 };

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: unknown; password?: unknown }>(event).catch(() => null);

  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!allowHit(`signup:ip:${clientAddress(event)}`, PER_IP.limit, PER_IP.windowMs)) {
    tooMany('Too many new accounts from here in a short time. Wait a few minutes and try again.');
  }

  if (email.length > 254 || !EMAIL.test(email)) {
    throw createError({ statusCode: 400, statusMessage: 'That email address does not look right.' });
  }
  if (password.length < 8) {
    throw createError({ statusCode: 400, statusMessage: 'Use a password of at least 8 characters.' });
  }
  // bcrypt truncates past 72 bytes; rejecting is honest, silently ignoring the rest is not.
  if (Buffer.byteLength(password, 'utf8') > 72) {
    throw createError({ statusCode: 400, statusMessage: 'That password is too long. 72 characters at most.' });
  }
  if (/^(.)\1+$/.test(password)) {
    throw createError({ statusCode: 400, statusMessage: 'Pick a password that is not one character repeated.' });
  }

  if (!allowHit(`signup:email:${email}`, PER_EMAIL.limit, PER_EMAIL.windowMs)) {
    tooMany();
  }

  const db = serverSupabaseServiceRole(event);

  const { data, error } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error) {
    const already = /already|registered|exists/i.test(error.message);
    if (!already) console.error(`[signup] createUser failed: ${error.message}`);
    throw createError({
      statusCode: already ? 409 : 500,
      statusMessage: already
        ? 'That email already has an account. Sign in, or reset your password.'
        : 'We could not create your account just now. Try again in a minute.',
    });
  }

  // The profile row comes from the on_auth_user_created trigger. If it ever does not, the
  // pack endpoint heals it on first use rather than failing on a foreign key.
  return { id: data.user?.id ?? null };
});
