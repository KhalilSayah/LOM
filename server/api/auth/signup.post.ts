import { serverSupabaseServiceRole } from '#supabase/server';

/**
 * Create an account that is already confirmed.
 *
 * Supabase's client-side `signUp` sends a confirmation mail unless the project has
 * "Confirm email" switched off in the dashboard. That toggle is reachable only through the
 * Management API, so an app cannot turn it off for itself, and the built-in SMTP allows a
 * few messages an hour — which means testing signup twice ends in `email rate limit
 * exceeded` and a half-made account.
 *
 * The admin API can create the user outright with `email_confirm: true`. No mail is sent,
 * no rate limit applies, and the dashboard setting stops mattering. The client then signs
 * in with the password it already has.
 *
 * What this endpoint is allowed to do is deliberately narrow: create a user with an email
 * and a password, nothing else. It never reads the request for a role, a profile field or
 * an id, because it holds the service-role key and anything it accepts from the body is
 * something a stranger can set.
 *
 * It is as open as the sign-up form itself, which for a private league is the intent. If
 * this ever needs to stop being open, the guard belongs here — an invite code checked
 * against a table — not in the client.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: string; password?: string }>(event);

  const email = String(body?.email ?? '').trim().toLowerCase();
  const password = String(body?.password ?? '');

  if (!EMAIL.test(email)) {
    throw createError({ statusCode: 400, statusMessage: 'That email address does not look right.' });
  }
  if (password.length < 8) {
    throw createError({ statusCode: 400, statusMessage: 'Use a password of at least 8 characters.' });
  }
  if (password.length > 72) {
    // bcrypt truncates past 72 bytes; rejecting is honest, silently ignoring the rest is not.
    throw createError({ statusCode: 400, statusMessage: 'That password is too long — 72 characters at most.' });
  }

  const db = serverSupabaseServiceRole(event);

  const { data, error } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error) {
    const already = /already|registered|exists/i.test(error.message);
    throw createError({
      statusCode: already ? 409 : 500,
      statusMessage: already
        ? 'That email already has an account. Sign in instead.'
        : error.message,
    });
  }

  // The profile row comes from the on_auth_user_created trigger. If it ever does not, the
  // pack endpoint heals it on first use rather than failing on a foreign key.
  return { id: data.user?.id ?? null };
});
