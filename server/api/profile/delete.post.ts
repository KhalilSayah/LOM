import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager } from '~~/server/utils/auth';
import { normaliseHandle } from '~~/shared/names';
import { allowHit, tooMany } from '~~/server/utils/rateLimit';

/**
 * Delete this account, for good.
 *
 * Body: { confirm: "<your handle>" }. Typing the handle is the confirmation; the server
 * checks it against the row rather than trusting the client to have asked.
 *
 * What goes: the auth user, and through `profiles.id references auth.users on delete
 * cascade` the profile and every row keyed on it — collection, roster, pity, pack claims
 * and openings, gifts, credit ledger, sponsors, discoveries (both directions), queue
 * entry, match rewards, season rewards, league seats, and every duel this manager was
 * challenger or opponent in (with its actions and rewards).
 *
 * What is protected first, because the cascade would otherwise take other people's games
 * with it:
 * - A league mid-season. Deleting a seat cascades its fixtures, which would tear holes
 *   in everyone else's schedule. The route refuses and says why.
 * - A league this manager hosts that has other people in it. `leagues.owner_id` cascades,
 *   so the whole league would vanish. Hosting passes to the longest-standing other member
 *   first; a league with nobody else in it goes with its host.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  if (!allowHit(`delete:${manager.id}`, 5, 10 * 60_000)) tooMany();

  const body = await readBody<{ confirm?: unknown }>(event).catch(() => null);
  const db = serverSupabaseServiceRole(event);

  const { data: profile } = await db.from('profiles').select('handle').eq('id', manager.id).maybeSingle();
  if (profile && normaliseHandle(body?.confirm) !== profile.handle) {
    throw createError({ statusCode: 400, statusMessage: 'Type your name exactly as shown to confirm.' });
  }

  const { data: seats, error: seatError } = await db
    .from('league_members')
    .select('id, league_id, is_owner, leagues!league_id ( id, name, status, owner_id )')
    .eq('profile_id', manager.id);

  if (seatError) {
    console.error(`[delete] could not read leagues: ${seatError.message}`);
    throw createError({ statusCode: 500, statusMessage: 'Your account could not be deleted just now. Try again.' });
  }

  const live = (seats || []).find((s: any) => s.leagues?.status === 'ACTIVE');
  if (live) {
    throw createError({
      statusCode: 409,
      statusMessage: `${(live as any).leagues.name} is mid-season. Deleting now would wipe your rivals' fixtures, so wait until the season ends.`,
    });
  }

  // Pass on hosting for any league that still has somebody else in it.
  for (const seat of (seats || []) as any[]) {
    if (seat.leagues?.owner_id !== manager.id) continue;
    const { data: others } = await db
      .from('league_members')
      .select('id, profile_id')
      .eq('league_id', seat.league_id)
      .neq('profile_id', manager.id)
      .order('joined_at', { ascending: true })
      .limit(1);
    const heir = others?.[0];
    if (!heir) continue;
    const { error: moveError } = await db.from('leagues').update({ owner_id: heir.profile_id }).eq('id', seat.league_id);
    if (moveError) {
      console.error(`[delete] could not hand over league ${seat.league_id}: ${moveError.message}`);
      throw createError({ statusCode: 500, statusMessage: 'Your account could not be deleted just now. Try again.' });
    }
    await db.from('league_members').update({ is_owner: true }).eq('id', heir.id);
  }

  const { error } = await db.auth.admin.deleteUser(manager.id);
  if (error) {
    console.error(`[delete] deleteUser failed: ${error.message}`);
    throw createError({ statusCode: 500, statusMessage: 'Your account could not be deleted just now. Try again.' });
  }

  return { deleted: true };
});
