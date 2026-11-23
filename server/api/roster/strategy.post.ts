import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { isStrategy, saveStrategy } from '~~/server/utils/strategy';

/**
 * Choose the team strategy preset (docs/01): STANDARD, AGGRESSIVE or SCALING today, or
 * whatever packages/sim/src/balance.js BALANCE.strategy holds tomorrow.
 *
 * The only writer of roster_strategy (migration 0018). It applies to every match the
 * manager's five play from here on; the sandbox reads it now, and duels read it through
 * server/utils/strategy.ts strategyFor.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  await ensureProfile(db, manager);

  const body = await readBody<{ strategy?: string }>(event);
  const strategy = String(body?.strategy ?? '').toUpperCase();

  if (!isStrategy(strategy)) {
    throw createError({ statusCode: 400, statusMessage: `${strategy || 'That'} is not a strategy.` });
  }

  await saveStrategy(db, manager.id, strategy);
  return { strategy };
});
