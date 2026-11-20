import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { entryFor, liveDuelFor, createBotDuel } from '~~/server/utils/duelQueue';

/**
 * Play the agent, because nobody is searching.
 *
 * Offered by the client after about twenty seconds of an empty queue, and never forced: it
 * is a button, and the search carries on behind it until the player takes it. The duel it
 * builds is a normal duel in every respect that the draft screen can see — the only marks on
 * it are `source = 'BOT'` and `bot_side`, which exist so that these games can be told apart
 * later, in a leaderboard that does not exist yet.
 *
 * This endpoint is why the empty-queue case is not a dead end. A game with no players is the
 * normal state of a new game, and a Battle button that leads to a spinner is a Battle button
 * nobody presses twice.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const live = await liveDuelFor(db, profileId);
  if (live) return { duelId: live, resumed: true };

  const entry = await entryFor(db, profileId);
  const duelId = await createBotDuel(db, profileId, entry);

  return { duelId, resumed: false };
});
