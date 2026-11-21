import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import {
  shapeLeague, membersOf, requireMatchHour, requireTimezone, assertLeagueRoom,
} from '~~/server/utils/league';
import { cleanTeamName } from '~~/shared/league';

/**
 * Host a league.
 *
 * The creator is its owner and its first member in the same breath — a league with
 * nobody in it is a row nobody can reach, and the owner joining their own league as
 * a separate step is a state that only exists to go wrong.
 *
 * The invite code is minted by the database (supabase/migrations/0009_leagues.sql),
 * not here: it has to stay unique against a table this route cannot lock.
 *
 * There is no season length any more. It was accepted and stored, and then mostly
 * ignored — and where it was not ignored, a short one cut the double round robin off
 * halfway. The length is now whatever "everyone against everyone twice" takes for the
 * number of managers who turn up (shared/league.ts `seasonShape`), and the form says
 * so. `seasonLengthDays` in an old client's body is simply not read.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const body = await readBody<{
    name?: string; timezone?: string; matchHour?: string; teamName?: string;
  }>(event);

  const name = String(body?.name ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 40) {
    throw createError({ statusCode: 400, statusMessage: 'Give the league a name, 2 to 40 characters.' });
  }

  const timezone = requireTimezone(body?.timezone);
  const matchHour = requireMatchHour(body?.matchHour ?? '20:30');

  // Finished leagues do not count against the cap (server/utils/league.ts).
  await assertLeagueRoom(db, profileId);

  const { data: profile } = await db
    .from('profiles').select('handle, display_name').eq('id', profileId).maybeSingle();

  const teamName = cleanTeamName(body?.teamName)
    ?? cleanTeamName(profile?.display_name || profile?.handle)
    ?? 'Manager';

  const { data: league, error } = await db
    .from('leagues')
    .insert({ name, owner_id: profileId, timezone, match_hour: matchHour })
    .select('id, name, owner_id, invite_code, timezone, match_hour, season_length_days, status, starts_on, created_at, started_at, finished_at, catalogue_version_id, season, champion_member_id')
    .single();

  if (error || !league) {
    throw createError({ statusCode: 500, statusMessage: error?.message || 'Could not create that league.' });
  }

  const { error: memberError } = await db.from('league_members').insert({
    league_id: league.id,
    profile_id: profileId,
    team_name: teamName,
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
