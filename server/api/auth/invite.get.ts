import { serverSupabaseServiceRole } from '#supabase/server';
import { normaliseLeagueCode, MAX_MANAGERS } from '~~/shared/league';
import { allowHit, clientAddress, tooMany } from '~~/server/utils/rateLimit';

/**
 * What the door may say about an invite before anyone has signed in.
 *
 * /api/league/preview is the full picture and needs an account. This is the public
 * subset, for two readers who have none: the person who tapped an invite in a group chat
 * and is now looking at the sign-in screen, and the link-preview bot that fetched the
 * same URL to draw a card for it. Both get the league's name, the host's name and how
 * many seats are taken — nothing else. No team names, no ids, no schedule.
 *
 * Never throws for a bad or unknown code: the door simply shows itself without an
 * invite banner, which is the right fallback for a mistyped link.
 */
export default defineEventHandler(async (event) => {
  if (!allowHit(`invite:${clientAddress(event)}`, 60, 60_000)) tooMany();

  const code = normaliseLeagueCode(getQuery(event).code as string | undefined);
  if (!code) return { found: false as const };

  const db = serverSupabaseServiceRole(event);

  const { data: league, error } = await db
    .from('leagues')
    .select('id, name, owner_id, status')
    .eq('invite_code', code)
    .maybeSingle();

  if (error) console.warn(`[invite] lookup failed: ${error.message}`);
  if (!league) return { found: false as const };

  const [{ count }, { data: host }] = await Promise.all([
    db.from('league_members').select('id', { count: 'exact', head: true }).eq('league_id', league.id),
    db.from('profiles').select('handle, display_name').eq('id', league.owner_id).maybeSingle(),
  ]);

  setResponseHeader(event, 'Cache-Control', 'public, max-age=60');

  return {
    found: true as const,
    league: league.name as string,
    host: (host?.display_name || host?.handle || 'A manager') as string,
    memberCount: count ?? 0,
    maxMembers: MAX_MANAGERS,
    open: league.status === 'FORMING' && (count ?? 0) < MAX_MANAGERS,
  };
});
