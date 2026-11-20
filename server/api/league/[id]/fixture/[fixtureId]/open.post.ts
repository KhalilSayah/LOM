import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { requireMembership } from '~~/server/utils/league';
import { openFixture, type FixtureRow } from '~~/server/utils/leagueFixture';

/**
 * Play tonight's fixture.
 *
 * One button for both managers and for every state the fixture can be in: not opened
 * yet, opened by the other one a moment ago, or already being drafted. All three
 * answer with the same duel id, and the screen navigates into the room — which is why
 * there is no separate "join" endpoint and no way for the two of them to end up in
 * different rooms.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const id = getRouterParam(event, 'id');
  const fixtureId = getRouterParam(event, 'fixtureId');
  if (!id || !fixtureId) throw createError({ statusCode: 400, statusMessage: 'Which fixture?' });

  const { league, members } = await requireMembership(db, id, profileId);

  if (league.status !== 'ACTIVE') {
    throw createError({
      statusCode: 409,
      statusMessage: league.status === 'FORMING'
        ? 'The season has not started yet.'
        : 'That season is over.',
    });
  }

  const { data: fixture, error } = await db
    .from('league_fixtures')
    .select('id, league_id, day_index, stage, blue_member_id, red_member_id, scheduled_at, status, duel_id')
    .eq('id', fixtureId)
    .eq('league_id', league.id)
    .maybeSingle();

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });
  if (!fixture) throw createError({ statusCode: 404, statusMessage: 'No such fixture.' });

  const { duelId, opened } = await openFixture(db, league, fixture as FixtureRow, members, profileId);

  return { duelId, opened, dayIndex: (fixture as FixtureRow).day_index };
});
