import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { requireMembership, requireOwner, shapeLeague } from '~~/server/utils/league';
import { startNextSeason } from '~~/server/utils/leagueSeason';

/**
 * Start the next season — docs/01 section 7 point 4.
 *
 * Owner-only, like the first launch, and for a stronger reason than that one: this commits
 * five other people to another fortnight of evenings on an evening when the last one has
 * only just finished. It is also the one button in the app that a group might want to *not*
 * press for a while, which is why nothing starts a new season automatically.
 *
 * Deliberately not called a reset anywhere a manager can see it. Nothing is reset: season 1
 * keeps its calendar, its results, its replays, its standings and its payouts, all still
 * readable (migration 0014 scopes them by season rather than deleting them). What happens is
 * that a second season begins beside the first.
 *
 * The unready-roster warning the first launch has is not repeated. Everybody in a league
 * that has played a whole season has a five; if somebody has since emptied theirs, the
 * fixture they cannot play tells them so on the evening, which is the same thing that
 * happens mid-season already.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Which league?' });

  const { league, members } = await requireMembership(db, id, profileId);
  requireOwner(league, profileId);

  const next = await startNextSeason(db, league, members);

  return {
    league: shapeLeague(
      {
        ...league,
        season: next.season,
        status: 'ACTIVE',
        starts_on: next.startsOn,
        champion_member_id: null,
      },
      members,
      profileId,
    ),
    ...next,
  };
});
