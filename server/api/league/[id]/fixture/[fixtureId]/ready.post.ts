import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { requireMembership } from '~~/server/utils/league';
import { markFixtureReady, FIXTURE_COLUMNS, type FixtureRow } from '~~/server/utils/leagueFixture';

/**
 * "Start as soon as we are both here" — or take it back.
 *
 * The room opens fifteen minutes before kick-off and the draft waits for kick-off, so
 * nobody can start the clock on a manager still on their way. Two managers who are both
 * in early should not have to sit through the rest of the countdown, though: when both
 * have said ready, the draft starts a few seconds later. Body: `{ ready: boolean }`.
 *
 * The league screen sends it with its Play button. The duel room's lobby can call this
 * too — it needs nothing but the league and fixture ids, both on the fixture row.
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
    throw createError({ statusCode: 409, statusMessage: 'There is no season being played.' });
  }

  const { data: fixture, error } = await db
    .from('league_fixtures')
    .select(FIXTURE_COLUMNS)
    .eq('id', fixtureId)
    .eq('league_id', league.id)
    .maybeSingle();

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });
  if (!fixture) throw createError({ statusCode: 404, statusMessage: 'No such fixture.' });

  const row = fixture as unknown as FixtureRow;
  if (row.status === 'FINAL') {
    throw createError({ statusCode: 409, statusMessage: 'That fixture has been played.' });
  }

  const body = await readBody<{ ready?: boolean }>(event).catch(() => null);
  const state = await markFixtureReady(db, row, members, profileId, body?.ready !== false);

  return { ...state, duelId: row.duel_id };
});
