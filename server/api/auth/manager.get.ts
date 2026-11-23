import { serverSupabaseServiceRole } from '#supabase/server';
import { normaliseShareCode } from '~~/shared/shareCode';
import { allowHit, clientAddress, tooMany } from '~~/server/utils/rateLimit';

/**
 * The one thing a shared collection link says before sign-in: whose it is.
 *
 * Used by the door to title the page when a signed-out visitor — or a link-preview bot —
 * follows /m/<code>. The display name only: the cards themselves stay behind an account,
 * as /api/discovery/collection keeps them.
 */
export default defineEventHandler(async (event) => {
  if (!allowHit(`manager:${clientAddress(event)}`, 60, 60_000)) tooMany();

  const code = normaliseShareCode(getQuery(event).code as string | undefined);
  if (!code) return { found: false as const };

  const db = serverSupabaseServiceRole(event);
  const { data, error } = await db
    .from('profiles')
    .select('handle, display_name')
    .eq('share_code', code)
    .maybeSingle();

  if (error) console.warn(`[manager] lookup failed: ${error.message}`);
  if (!data) return { found: false as const };

  setResponseHeader(event, 'Cache-Control', 'public, max-age=300');
  return { found: true as const, name: (data.display_name || data.handle) as string };
});
