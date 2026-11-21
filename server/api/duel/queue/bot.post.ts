import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { entryFor, liveDuelFor, createBotDuel } from '~~/server/utils/duelQueue';
import { asDifficulty } from '~~/shared/duelRoom';

/**
 * Play the agent.
 *
 * Two ways in. The queue offers it after about twenty seconds of nobody, as a button, with
 * the search carrying on behind it; that game is against the agent at NORMAL. The Battle
 * screen also has a direct "Practice vs the agent" with a difficulty, for somebody who wants
 * to try a draft without waiting for anyone — that one sends `difficulty`.
 *
 * Either way the duel is a normal duel in every respect the draft screen can see. The marks
 * on it are `source = 'BOT'`, `bot_side` and (practice) `difficulty`, and none of it counts
 * anywhere: no ladder, no standings, no record that is not labelled practice.
 *
 * The live-room check below is a fast path, not the guarantee. createBotDuel checks again
 * after its insert, and migration 0015's index refuses a second practice draft outright,
 * because a check followed by an insert is exactly the window two taps fall into.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const body = await readBody<{ difficulty?: string } | null>(event).catch(() => null);
  const difficulty = body?.difficulty ? asDifficulty(body.difficulty) : null;

  const live = await liveDuelFor(db, profileId);
  if (live) return { duelId: live, resumed: true };

  const entry = await entryFor(db, profileId);
  const duelId = await createBotDuel(db, profileId, entry, difficulty);

  return { duelId, resumed: false };
});
