import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { leagueByCode, membersOf, shapeLeague } from '~~/server/utils/league';
import { MAX_MANAGERS } from '~~/shared/league';

/**
 * Join a league with an invite code.
 *
 * The code is the whole authorisation while a league is FORMING, and it stops being
 * a way in the moment the season starts: a league that has begun playing cannot take
 * a seventh manager on day 4 without invalidating every fixture already generated.
 *
 * The count check here is for the message. The rule is the trigger in
 * supabase/migrations/0009_leagues.sql, because two people tapping the same invite
 * link at the same moment would both read a count of five.
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

  const { data: profile } = await db
    .from('profiles').select('handle, display_name').eq('id', profileId).maybeSingle();

  const asked = String(body?.teamName ?? '').trim();
  const teamName = (asked || profile?.display_name || profile?.handle || 'Manager').slice(0, 24);

  const { error } = await db.from('league_members').insert({
    league_id: league.id,
    profile_id: profileId,
    team_name: teamName,
  });

  if (error) {
    // The cap trigger raises check_violation with this message; the unique index on
    // (league_id, profile_id) is 23505 and means somebody double-tapped.
    if (error.message?.includes('league_full')) {
      throw createError({ statusCode: 409, statusMessage: `${league.name} filled up while you were joining.` });
    }
    if (error.code !== '23505') {
      throw createError({ statusCode: 500, statusMessage: error.message });
    }
  }

  const after = await membersOf(db, league.id);
  return { league: shapeLeague(league, after, profileId), alreadyIn: false };
});
