import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { requireMembership } from '~~/server/utils/league';

/**
 * Leave a league, or — if you are its owner and it has not started — disband it.
 *
 * Only while FORMING. Once a season is running, every fixture after today points at
 * a membership row, and removing one would either leave dangling fixtures or silently
 * delete half of somebody else's calendar. The honest answer to "I want out of a
 * running league" is a league pause and a forfeit, which docs/05 section 7 specifies
 * and nothing implements yet, so this says so instead of half-doing it.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Which league?' });

  const { league, me } = await requireMembership(db, id, profileId);

  if (league.status !== 'FORMING') {
    throw createError({
      statusCode: 409,
      statusMessage: `${league.name} has already started. Ask the owner to finish the season.`,
    });
  }

  if (league.owner_id === profileId) {
    const { error } = await db.from('leagues').delete().eq('id', league.id);
    if (error) throw createError({ statusCode: 500, statusMessage: error.message });
    return { disbanded: true, name: league.name };
  }

  const { error } = await db.from('league_members').delete().eq('id', me.id);
  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  return { disbanded: false, name: league.name };
});
