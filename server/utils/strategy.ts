import type { SupabaseClient } from '@supabase/supabase-js';
import { BALANCE } from '~~/packages/sim/src/balance.js';
import { DEFAULT_STRATEGY } from '~~/shared/roster';

/**
 * The manager's team strategy: one of the presets packages/sim/src/balance.js already plays
 * (BALANCE.strategy), stored per manager in `roster_strategy` (migration 0018).
 *
 * The preset list is the engine's, not this file's: a name is valid exactly when the sim has
 * numbers for it, so a balance pass that adds or retires a preset needs no change here.
 */
export const isStrategy = (name: unknown): name is string =>
  typeof name === 'string' && Object.prototype.hasOwnProperty.call(BALANCE.strategy, name);

/**
 * The strategy a manager's team plays under. 'STANDARD' when they never chose one, when the
 * stored name is no longer a preset, or when the table does not exist yet (0018 not run) —
 * a match must never fail to start over a tactics setting.
 */
export async function strategyFor(db: SupabaseClient, profileId: string): Promise<string> {
  const { data, error } = await db
    .from('roster_strategy')
    .select('strategy')
    .eq('profile_id', profileId)
    .maybeSingle();

  if (error || !data) return DEFAULT_STRATEGY;
  return isStrategy((data as any).strategy) ? (data as any).strategy : DEFAULT_STRATEGY;
}

/** The one writer, called from /api/roster/strategy after the name is checked. */
export async function saveStrategy(db: SupabaseClient, profileId: string, strategy: string): Promise<void> {
  const { error } = await db
    .from('roster_strategy')
    .upsert(
      { profile_id: profileId, strategy, updated_at: new Date().toISOString() },
      { onConflict: 'profile_id' },
    );
  if (error) throw createError({ statusCode: 500, statusMessage: error.message });
}
