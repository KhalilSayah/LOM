import type { H3Event } from 'h3';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serverSupabaseUser } from '#supabase/server';

/**
 * Who is asking, and do they have a profile row yet.
 *
 * Two sharp edges live here rather than in every route:
 *
 * 1. `serverSupabaseUser()` in @nuxtjs/supabase 2.x resolves through `auth.getClaims()`,
 *    so what comes back is a decoded JWT, not a `User`. The id is `sub`; there is no `id`
 *    field at all. Reading `.id` gives `undefined`, which Postgres then rejects as a null
 *    profile_id — a confusing error a long way from its cause. Older versions of the module
 *    did return a User, so both shapes are read.
 *
 * 2. The profile row is normally minted by the `on_auth_user_created` trigger, but any
 *    account that signed up before the migration ran has no profile and never will. Rather
 *    than leave those accounts permanently unable to open a pack, `ensureProfile` creates
 *    the row on demand with the same handle rules as the trigger.
 */

export interface Manager {
  id: string;
  email: string | null;
}

export async function requireManager(event: H3Event): Promise<Manager> {
  const claims = await serverSupabaseUser(event) as Record<string, any> | null;
  const id = claims?.sub || claims?.id;

  if (!id) throw createError({ statusCode: 401, statusMessage: 'Sign in first' });

  return { id, email: claims?.email ?? null };
}

const handleBase = (email: string | null) => {
  const local = (email || '').split('@')[0] || '';
  const cleaned = local.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16);
  return cleaned.length >= 3 ? cleaned : 'manager';
};

/** Returns the profile id, creating the row if the signup trigger never ran for it. */
export async function ensureProfile(db: SupabaseClient, manager: Manager): Promise<string> {
  const { data: existing } = await db
    .from('profiles')
    .select('id')
    .eq('id', manager.id)
    .maybeSingle();

  if (existing) return existing.id;

  const base = handleBase(manager.email);
  for (let n = 0; n < 25; n++) {
    const handle = n === 0 ? base : `${base.slice(0, 16)}${n}`;
    const { error } = await db
      .from('profiles')
      .insert({ id: manager.id, handle, display_name: handle });

    if (!error) return manager.id;
    // 23505 is a unique violation: either the handle is taken, or the row appeared
    // underneath us from a concurrent request. Only the first is worth retrying.
    if (error.code !== '23505') {
      throw createError({ statusCode: 500, statusMessage: `profile: ${error.message}` });
    }
    const { data: now } = await db.from('profiles').select('id').eq('id', manager.id).maybeSingle();
    if (now) return now.id;
  }

  throw createError({ statusCode: 500, statusMessage: 'Could not allocate a handle' });
}
