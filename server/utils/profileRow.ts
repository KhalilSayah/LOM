import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The signed-in manager's own profile row, as the account screens need it.
 *
 * `handle_chosen` and `team_name` arrive with migration 0020. Until the owner has run it
 * the select falls back to the columns 0001/0002 created, so Settings and the name step
 * keep working (the name step then simply shows every time it is reached, which is
 * harmless) instead of failing on an unknown column.
 */

export interface OwnProfile {
  handle: string;
  displayName: string;
  teamName: string | null;
  handleChosen: boolean;
  shareCode: string | null;
  createdAt: string | null;
}

/** True when PostgREST says a column does not exist (the migration has not been run). */
export function isMissingColumn(error: { code?: string; message?: string } | null | undefined) {
  if (!error) return false;
  return error.code === '42703' || error.code === 'PGRST204'
    || /column .* does not exist|could not find the .* column/i.test(error.message || '');
}

export async function readOwnProfile(db: SupabaseClient, id: string): Promise<OwnProfile | null> {
  let { data, error } = await db
    .from('profiles')
    .select('handle, display_name, team_name, handle_chosen, share_code, created_at')
    .eq('id', id)
    .maybeSingle();

  if (isMissingColumn(error)) {
    ({ data, error } = await db
      .from('profiles')
      .select('handle, display_name, share_code, created_at')
      .eq('id', id)
      .maybeSingle() as any);
  }

  if (error) {
    console.error(`[profile] read failed: ${error.message}`);
    throw createError({ statusCode: 500, statusMessage: 'Your profile could not be loaded. Try again.' });
  }
  if (!data) return null;

  const row = data as Record<string, any>;
  return {
    handle: row.handle,
    displayName: row.display_name || row.handle,
    teamName: row.team_name ?? null,
    handleChosen: row.handle_chosen ?? false,
    shareCode: row.share_code ?? null,
    createdAt: row.created_at ?? null,
  };
}
