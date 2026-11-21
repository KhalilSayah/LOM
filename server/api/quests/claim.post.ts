import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { configuredWindow } from '~~/server/utils/packDay';
import { questBoard } from '~~/server/utils/quests';

/**
 * Collect a finished quest.
 *
 * The client only names the quest. Whether it is live this period, whether it is done and
 * what it pays are all decided here, from the same board the quests screen reads, and the
 * payout goes through `lom_claim_quest` (migration 0019): one insert on a unique key and the
 * ledger entry, in one transaction, so a quest pays once however many times it is tapped.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);
  const window = configuredWindow(useRuntimeConfig());

  const body = await readBody<{ key?: string }>(event).catch(() => ({} as { key?: string }));
  const key = String(body?.key ?? '').trim().toUpperCase();
  if (!key) throw createError({ statusCode: 400, statusMessage: 'Which quest?' });

  const board = await questBoard(db, profileId, window);
  const daily = board.daily.quests.find((q) => q.key === key);
  const weekly = board.weekly.quests.find((q) => q.key === key);
  const quest = daily ?? weekly;
  const periodKey = daily ? board.daily.periodKey : board.weekly.periodKey;

  if (!quest) throw createError({ statusCode: 404, statusMessage: 'That quest is not live any more.' });
  if (quest.claimed) throw createError({ statusCode: 409, statusMessage: 'Already collected.' });
  if (!quest.done) throw createError({ statusCode: 409, statusMessage: 'Not finished yet.' });

  const { data, error } = await db.rpc('lom_claim_quest', {
    p_profile: profileId,
    p_quest: quest.key,
    p_period: periodKey,
    p_credits: quest.credits,
  });

  if (error) {
    console.error('[quests] claim failed', { code: error.code, message: error.message });
    throw createError({
      statusCode: error.code === 'PGRST202' ? 503 : 500,
      statusMessage: error.code === 'PGRST202'
        ? 'Quests are not set up yet. Run supabase/migrations/0019_economy_integrity.sql.'
        : 'Could not collect that quest. Try again.',
    });
  }

  const res = data as { status: string; credits?: number };
  if (res.status !== 'claimed') throw createError({ statusCode: 409, statusMessage: 'Already collected.' });

  return {
    key: quest.key,
    paid: quest.credits,
    credits: res.credits ?? 0,
    claimable: Math.max(0, board.claimable - 1),
  };
});
