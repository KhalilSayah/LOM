import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { managerByCode, summariseCollections, rememberDiscovery } from '~~/server/utils/discovery';

/**
 * Look up a manager by their share code, and remember them.
 *
 * The search and the keeping are one action on purpose: "once you have found someone
 * you can always get back to their collection" is the feature, and an explicit
 * follow-up tap to save them would be a step everybody takes every time.
 *
 * Your own code resolves to a plain refusal rather than a 404. It is the single most
 * likely thing to be typed in here first, and "no manager has that code" would be a
 * lie about the one code the person definitely has.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  await ensureProfile(db, manager);

  const body = await readBody<{ code?: string }>(event);
  const found = await managerByCode(db, body?.code);

  if (found.id === manager.id) {
    throw createError({
      statusCode: 400,
      statusMessage: 'That is your own code — share it with someone else.',
    });
  }

  await rememberDiscovery(db, manager, found.id);

  const summaries = await summariseCollections(db, [found.id]);

  return {
    manager: found,
    collection: summaries.get(found.id),
  };
});
