import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { requireMembership, requireOwner } from '~~/server/utils/league';
import { ensurePlayoffs, advancePlayoffs } from '~~/server/utils/leaguePlayoffs';

/**
 * Draw the bracket, or carry it forward — the owner's repair button.
 *
 * The bracket is drawn automatically the moment the last regular fixture goes FINAL, from
 * inside recordFixtureResult, and that is how it happens in a season that goes normally
 * (server/utils/leaguePlayoffs.ts says why it is not done lazily on a read). This route
 * exists because that automatic call lives in a `catch` that must never take a finished
 * match down with it: a transient failure there would otherwise leave a league with a
 * complete regular season and no way out of it short of a migration.
 *
 * So it is deliberately not an override. It calls the same two functions, with the same
 * guards, and a league with a regular fixture nobody has played is told how many are
 * outstanding rather than having a bracket forced on it — overriding that is a forfeit, and
 * forfeits are docs/05 section 7 and are not built.
 *
 * Owner-only, like launch. Not because drawing a bracket twice would do damage — both calls
 * are idempotent — but because "has our season finished" is a question one person in a group
 * chat should be answering.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Which league?' });

  const { league } = await requireMembership(db, id, profileId);
  requireOwner(league, profileId);

  const drawn = await ensurePlayoffs(db, id);

  /**
   * Then advance, whether or not this call is the one that drew it.
   *
   * A bracket drawn a moment ago has nothing to advance and says so cheaply. A bracket whose
   * semis were decided while the automatic hook was failing has a final waiting for its
   * sides, and this is what fills them in — which is the repair that matters most, because
   * a final with a missing side cannot be opened.
   */
  const advanced = await advancePlayoffs(db, id);

  return {
    generated: drawn.generated,
    /** Null when there was nothing to say: the bracket was drawn by this call. */
    reason: drawn.generated ? null : drawn.reason ?? null,
    outstanding: drawn.outstanding ?? 0,
    finished: advanced.finished,
    championMemberId: advanced.championMemberId,
  };
});
