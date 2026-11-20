import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { summariseCollections } from '~~/server/utils/discovery';
import { requireMembership } from '~~/server/utils/league';
import { CARD_SELECT, toCard } from '~~/shared/cardShape';
import { ROLES } from '~~/shared/roster';

/**
 * A leaguemate's squad: the five they field, and the collection behind it.
 *
 * Being in a league together is the authorisation. Discovery needs a share code
 * because it reaches any account in the app; this reaches only the people the asking
 * manager already sits in a table with, and sharing a league is exactly the kind of
 * consent that makes a collection worth showing off. Nothing else about the account
 * comes back — no email, no pity counter, no pack history.
 *
 * The shape is the one /collection and /roster already render, so the screen reuses
 * LomCard rather than translating cards a second time.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const id = getRouterParam(event, 'id');
  const memberId = getRouterParam(event, 'memberId');
  if (!id || !memberId) throw createError({ statusCode: 400, statusMessage: 'Which manager?' });

  const { league, members } = await requireMembership(db, id, profileId);
  const member = members.find((m) => m.id === memberId);
  if (!member) throw createError({ statusCode: 404, statusMessage: 'Nobody by that name in this league.' });

  const [{ data: profile }, { data: slots }, { data: owned, error }, summaries] = await Promise.all([
    db.from('profiles').select('id, handle, display_name, share_code, created_at')
      .eq('id', member.profile_id).maybeSingle(),
    db.from('roster_slots').select('role, collection_card_id, updated_at')
      .eq('profile_id', member.profile_id),
    db.from('collection_cards')
      .select(`id, level, xp, copies, acquired_at, card_definitions ( ${CARD_SELECT} )`)
      .eq('profile_id', member.profile_id)
      .order('acquired_at', { ascending: false }),
    summariseCollections(db, [member.profile_id]),
  ]);

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  const cards = (owned || [])
    .filter((row: any) => row.card_definitions)
    .map((row: any) => ({
      id: row.id,
      level: row.level,
      copies: row.copies,
      acquiredAt: row.acquired_at,
      card: toCard(row.card_definitions),
    }));

  const byId = new Map(cards.map((c) => [c.id, c]));
  const roster: Record<string, any> = {};
  for (const role of ROLES) roster[role] = null;
  for (const slot of (slots || []) as any[]) {
    const held = byId.get(slot.collection_card_id);
    if (held) roster[slot.role] = { ...held, updatedAt: slot.updated_at };
  }

  return {
    league: { id: league.id, name: league.name, status: league.status },
    member: {
      id: member.id,
      profileId: member.profile_id,
      teamName: member.team_name,
      isOwner: member.is_owner,
      isMe: member.profile_id === profileId,
      handle: profile?.handle ?? null,
      displayName: profile?.display_name ?? profile?.handle ?? 'Manager',
      joinedAt: member.joined_at,
    },
    collection: summaries.get(member.profile_id) ?? { total: 0, bands: {}, best: null },
    roster,
    rosterFilled: ROLES.filter((r) => roster[r]).length,
    cards,
  };
});
