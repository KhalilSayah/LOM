import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import {
  requireMembership, requireOwner, requireMatchHour, requireTimezone, shapeLeague, LEAGUE_SELECT,
  type LeagueRow,
} from '~~/server/utils/league';

/**
 * The owner changes when the league plays: its match hour, its timezone, its name.
 *
 * Only while FORMING. Once the season starts every fixture is a row with an instant on
 * it that six people have read, and moving the hour would mean rewriting a calendar
 * people have already planned their evenings around — that is a league pause or a
 * reschedule (docs/05 section 7), not a setting. Before then nothing has been promised,
 * and the preview on the league screen moves with the change.
 *
 * Body: any of `{ matchHour, timezone, name }`.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Which league?' });

  const { league, members } = await requireMembership(db, id, profileId);
  requireOwner(league, profileId);

  if (league.status !== 'FORMING') {
    throw createError({
      statusCode: 409,
      statusMessage: 'The match hour is fixed once the season has started.',
    });
  }

  const body = await readBody<{ matchHour?: string; timezone?: string; name?: string }>(event);
  const patch: Record<string, string> = {};

  if (body?.matchHour !== undefined) patch.match_hour = requireMatchHour(body.matchHour);
  if (body?.timezone !== undefined) patch.timezone = requireTimezone(body.timezone);
  if (body?.name !== undefined) {
    const name = String(body.name).replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 40) {
      throw createError({ statusCode: 400, statusMessage: 'Give the league a name, 2 to 40 characters.' });
    }
    patch.name = name;
  }

  if (!Object.keys(patch).length) {
    throw createError({ statusCode: 400, statusMessage: 'Nothing to change.' });
  }

  const { data, error } = await db
    .from('leagues')
    .update(patch)
    .eq('id', league.id)
    // The same guard as the check above, in the database: a Start season that lands
    // between the two must not have its calendar's hour changed under it.
    .eq('status', 'FORMING')
    .select(LEAGUE_SELECT)
    .maybeSingle();

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });
  if (!data) {
    throw createError({ statusCode: 409, statusMessage: 'The season started a moment ago, so the hour is fixed.' });
  }

  return { league: shapeLeague(data as LeagueRow, members, profileId) };
});
