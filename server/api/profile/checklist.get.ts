import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { WELCOME_REASON } from '~~/server/utils/gifts';
import { readOwnProfile } from '~~/server/utils/profileRow';

/**
 * The four first steps on Home, each read from the thing it is about.
 *
 * Nothing here is a flag the client sets: a step is done because the welcome pack has been
 * opened, because five roster slots are filled, because a practice duel ended with this
 * manager on the winning side, because a league membership exists. So the card can never
 * say "done" about something that is not, and it ticks off for accounts that did the steps
 * before the checklist existed.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const id = await ensureProfile(db, manager);

  const [welcome, cards, slots, practice, leagues, profile] = await Promise.all([
    db.from('pack_gifts').select('opened_at').eq('profile_id', id).eq('reason', WELCOME_REASON).maybeSingle(),
    db.from('collection_cards').select('id', { count: 'exact', head: true }).eq('profile_id', id),
    db.from('roster_slots').select('profile_id', { count: 'exact', head: true }).eq('profile_id', id),
    db.from('duels')
      .select('blue_id, red_id, result')
      .eq('source', 'BOT')
      .eq('status', 'COMPLETE')
      .or(`challenger_id.eq.${id},opponent_id.eq.${id}`)
      .order('created_at', { ascending: false })
      .limit(30),
    db.from('league_members').select('id', { count: 'exact', head: true }).eq('profile_id', id),
    readOwnProfile(db, id).catch(() => null),
  ]);

  // An account from before the welcome pack existed has no such gift: it counts as opened
  // once there is anything in the collection, since that account has clearly started.
  const welcomeOpened = welcome.data
    ? Boolean(welcome.data.opened_at)
    : (cards.count ?? 0) > 0;

  const wonPractice = (practice.data || []).some((d: any) => {
    const winner = d.result?.winner;
    if (!winner) return false;
    const mySide = d.blue_id === id ? 'BLUE' : d.red_id === id ? 'RED' : null;
    return mySide === winner;
  });

  return {
    steps: {
      welcome: welcomeOpened,
      five: (slots.count ?? 0) >= 5,
      practice: wonPractice,
      league: (leagues.count ?? 0) > 0,
    },
    hasWelcomeGift: Boolean(welcome.data && !welcome.data.opened_at),
    handle: profile?.handle ?? null,
    handleChosen: profile?.handleChosen ?? true,
  };
});
