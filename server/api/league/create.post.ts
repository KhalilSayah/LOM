import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { shapeLeague, membersOf } from '~~/server/utils/league';

/**
 * Host a league.
 *
 * The creator is its owner and its first member in the same breath — a league with
 * nobody in it is a row nobody can reach, and the owner joining their own league as
 * a separate step is a state that only exists to go wrong.
 *
 * The invite code is minted by the database (supabase/migrations/0009_leagues.sql),
 * not here: it has to stay unique against a table this route cannot lock.
 */

const MAX_LEAGUES_PER_MANAGER = 8;

/** A timezone the runtime actually knows. An unknown one would throw at kick-off. */
function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const body = await readBody<{
    name?: string; timezone?: string; matchHour?: string; seasonLengthDays?: number;
  }>(event);

  const name = String(body?.name ?? '').trim();
  if (name.length < 2 || name.length > 40) {
    throw createError({ statusCode: 400, statusMessage: 'Give the league a name, 2 to 40 characters.' });
  }

  const timezone = String(body?.timezone ?? '').trim() || 'Europe/Paris';
  if (!validTimezone(timezone)) {
    throw createError({ statusCode: 400, statusMessage: `${timezone} is not a timezone this app knows.` });
  }

  const matchHour = String(body?.matchHour ?? '20:30').trim();
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(matchHour)) {
    throw createError({ statusCode: 400, statusMessage: 'The match hour looks like 20:30.' });
  }

  const seasonLengthDays = Number(body?.seasonLengthDays ?? 14);
  if (!Number.isInteger(seasonLengthDays) || seasonLengthDays < 2 || seasonLengthDays > 60) {
    throw createError({ statusCode: 400, statusMessage: 'A season is between 2 and 60 days.' });
  }

  const { count } = await db
    .from('league_members')
    .select('id', { count: 'exact', head: true })
    .eq('profile_id', profileId);

  if ((count ?? 0) >= MAX_LEAGUES_PER_MANAGER) {
    throw createError({
      statusCode: 409,
      statusMessage: `You are in ${count} leagues already. Leave one before starting another.`,
    });
  }

  const { data: profile } = await db
    .from('profiles').select('handle, display_name').eq('id', profileId).maybeSingle();

  const { data: league, error } = await db
    .from('leagues')
    .insert({ name, owner_id: profileId, timezone, match_hour: matchHour, season_length_days: seasonLengthDays })
    .select('id, name, owner_id, invite_code, timezone, match_hour, season_length_days, status, starts_on, created_at, started_at, catalogue_version_id')
    .single();

  if (error || !league) {
    throw createError({ statusCode: 500, statusMessage: error?.message || 'Could not create that league.' });
  }

  const { error: memberError } = await db.from('league_members').insert({
    league_id: league.id,
    profile_id: profileId,
    team_name: (profile?.display_name || profile?.handle || 'Manager').slice(0, 24),
    is_owner: true,
  });

  // A league the owner is not in is worse than no league: delete it rather than
  // leave a row that only an invite code can reach.
  if (memberError) {
    await db.from('leagues').delete().eq('id', league.id);
    throw createError({ statusCode: 500, statusMessage: memberError.message });
  }

  const members = await membersOf(db, league.id);
  return { league: shapeLeague(league as any, members, profileId) };
});
