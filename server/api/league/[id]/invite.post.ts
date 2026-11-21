import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { requireMembership, requireOwner } from '~~/server/utils/league';

/**
 * A new invite code; the old one stops working.
 *
 * The code is the whole of the join authorisation while a league forms (migration
 * 0009), so a link that has escaped into the wrong chat is a seat anybody can take.
 * Minting a new one is the fix. The database mints it — `gen_league_code()` is what the
 * insert trigger already uses, and it is unique against every league — and the unique
 * index settles the vanishingly rare race with another league minting the same code.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Which league?' });

  const { league } = await requireMembership(db, id, profileId);
  requireOwner(league, profileId);

  if (league.status !== 'FORMING') {
    throw createError({ statusCode: 409, statusMessage: 'The invite closed when the season started.' });
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: code, error: mintError } = await db.rpc('gen_league_code');
    if (mintError || typeof code !== 'string') {
      throw createError({ statusCode: 500, statusMessage: mintError?.message || 'Could not mint a code.' });
    }

    const { data, error } = await db
      .from('leagues')
      .update({ invite_code: code })
      .eq('id', league.id)
      .eq('status', 'FORMING')
      .select('invite_code')
      .maybeSingle();

    if (error?.code === '23505') continue;
    if (error) throw createError({ statusCode: 500, statusMessage: error.message });
    if (!data) throw createError({ statusCode: 409, statusMessage: 'The season started a moment ago.' });

    return { inviteCode: data.invite_code };
  }

  throw createError({ statusCode: 500, statusMessage: 'Could not mint a fresh code. Try again.' });
});
