import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { requireMembership, requireOwner } from '~~/server/utils/league';

/**
 * The owner removes somebody from a league that has not started.
 *
 * For the invite link that got forwarded one group chat too far. Only while FORMING,
 * for the same reason leaving is: once the season starts, every fixture after today
 * points at a membership row, and removing one would delete half of somebody else's
 * calendar. Nothing about the removed manager's account is touched — they keep their
 * collection, and they could rejoin with the code, which is why the owner can also
 * mint a new one (invite.post.ts).
 *
 * Body: `{ memberId }`.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Which league?' });

  const { league, members, me } = await requireMembership(db, id, profileId);
  requireOwner(league, profileId);

  if (league.status !== 'FORMING') {
    throw createError({ statusCode: 409, statusMessage: 'Nobody can be removed once the season has started.' });
  }

  const body = await readBody<{ memberId?: string }>(event);
  const target = members.find((m) => m.id === body?.memberId);
  if (!target) throw createError({ statusCode: 404, statusMessage: 'Nobody by that name in this league.' });
  if (target.id === me.id) {
    throw createError({ statusCode: 400, statusMessage: 'Disband the league instead of removing yourself.' });
  }

  // Re-check FORMING in the same statement's neighbourhood: a launch that landed after
  // the read above has already written fixtures pointing at this row, and the cascade
  // would take them with it.
  const { data: still } = await db
    .from('leagues').select('status').eq('id', league.id).maybeSingle();
  if (still?.status !== 'FORMING') {
    throw createError({ statusCode: 409, statusMessage: 'The season started a moment ago.' });
  }

  const { error } = await db.from('league_members').delete().eq('id', target.id);
  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  return { removed: target.id, teamName: target.team_name };
});
