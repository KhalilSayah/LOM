import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { requireMembership } from '~~/server/utils/league';
import { cleanTeamName, TEAM_NAME_MAX } from '~~/shared/league';

/**
 * Rename your team in this league.
 *
 * Any time, in any state: a team name is a name, not a commitment, and the same person
 * being "Khalil" in one league and "T1 Fanclub" in another is half the fun of a private
 * league (migration 0009). Every screen reads the name from the membership row, so the
 * table, the calendar and the bracket all follow at once.
 *
 * Two teams in one league may not share a name, ignoring case — a table where two rows
 * read the same is a table nobody can argue about. Body: `{ teamName }`.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Which league?' });

  const { members, me } = await requireMembership(db, id, profileId);

  const body = await readBody<{ teamName?: string }>(event);
  const teamName = cleanTeamName(body?.teamName);
  if (!teamName) {
    throw createError({ statusCode: 400, statusMessage: `A team name is 1 to ${TEAM_NAME_MAX} characters.` });
  }

  const taken = members.some((m) => m.id !== me.id && m.team_name.toLowerCase() === teamName.toLowerCase());
  if (taken) {
    throw createError({ statusCode: 409, statusMessage: `Somebody in this league is already ${teamName}.` });
  }

  const { error } = await db.from('league_members').update({ team_name: teamName }).eq('id', me.id);
  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  return { memberId: me.id, teamName };
});
