import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import {
  leagueByCode, membersOf, shapeLeague, assertLeagueRoom, defaultTeamName,
} from '~~/server/utils/league';
import { MAX_MANAGERS, cleanTeamName } from '~~/shared/league';

/**
 * Join a league with an invite code.
 *
 * The code is the whole authorisation while a league is FORMING, and it stops being
 * a way in the moment the season starts: a league that has begun playing cannot take
 * a seventh manager on day 4 without invalidating every fixture already generated.
 *
 * The checks here are for the message. The rules are the trigger in
 * supabase/migrations/0016_league_fair_play.sql, which takes a lock on the league row
 * before it counts: two people tapping the same invite link at the same moment would
 * both read a count of five, and a join racing the owner's Start season would both see
 * FORMING. The trigger sees them in order.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const body = await readBody<{ code?: string; teamName?: string }>(event);
  const league = await leagueByCode(db, body?.code);

  const members = await membersOf(db, league.id);
  const already = members.find((m) => m.profile_id === profileId);
  if (already) {
    // Not an error: following your own invite link twice should land you in the league.
    return { league: shapeLeague(league, members, profileId), alreadyIn: true };
  }

  if (league.status !== 'FORMING') {
    throw createError({
      statusCode: 409,
      statusMessage: league.status === 'ACTIVE'
        ? `${league.name} has already started its season.`
        : `${league.name} is finished.`,
    });
  }

  if (members.length >= MAX_MANAGERS) {
    throw createError({ statusCode: 409, statusMessage: `${league.name} is full (${MAX_MANAGERS} managers).` });
  }

  // The same cap as hosting: a league you join is as many evenings as one you host.
  await assertLeagueRoom(db, profileId);

  // Typed, else the profile's own team name, display name, then handle.
  const teamName = cleanTeamName(body?.teamName) ?? await defaultTeamName(db, profileId);

  const { error } = await db.from('league_members').insert({
    league_id: league.id,
    profile_id: profileId,
    team_name: teamName,
  });

  if (error) {
    // The trigger raises check_violation with these messages; the unique index on
    // (league_id, profile_id) is 23505 and means somebody double-tapped.
    if (error.message?.includes('league_full')) {
      throw createError({ statusCode: 409, statusMessage: `${league.name} filled up while you were joining.` });
    }
    if (error.message?.includes('league_closed')) {
      throw createError({ statusCode: 409, statusMessage: `${league.name} started its season while you were joining.` });
    }
    if (error.code !== '23505') {
      throw createError({ statusCode: 500, statusMessage: error.message });
    }
  }

  const after = await membersOf(db, league.id);
  return { league: shapeLeague(league, after, profileId), alreadyIn: false };
});
