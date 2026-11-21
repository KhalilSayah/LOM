import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { sponsorBook } from '~~/server/utils/sponsors';

/**
 * The sponsor book: every brand, the terms, which of them you hold, and which are live.
 *
 * The whole catalogue goes out, owned or not, for the same reason the shop publishes its
 * drop odds (migration 0004): terms you cannot read until you have signed are not terms,
 * and a manager deciding whether 600 Credits is worth a sponsor meeting should be able to
 * see what is in the deck.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const [book, { data: profile }] = await Promise.all([
    sponsorBook(db, profileId),
    db.from('profiles').select('credits').eq('id', profileId).single(),
  ]);

  return { credits: profile?.credits ?? 0, ...book };
});
