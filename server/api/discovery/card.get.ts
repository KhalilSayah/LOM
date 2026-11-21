import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { managerByCode, rememberDiscovery } from '~~/server/utils/discovery';
import { CARD_SELECT, toCard } from '~~/shared/cardShape';

/**
 * One card from somebody else's collection, by code and card key: the read-only card view.
 *
 * Same authorisation as /api/discovery/collection — the code is the permission — and the
 * same fixed shape: the card, its level, XP and duplicate count, nothing about the account.
 *
 * A card key names a player-season, not a printing, so a manager who kept a card from an
 * older catalogue can hold two rows under one key. The one from the active catalogue wins;
 * after that, the most recent.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  await ensureProfile(db, manager);

  const query = getQuery(event);
  const key = String(query.key || '').trim();
  if (!key) throw createError({ statusCode: 400, statusMessage: 'Which card?' });

  const found = await managerByCode(db, query.code as string | undefined);
  await rememberDiscovery(db, manager, found.id);

  const [{ data: rows, error }, { data: active }] = await Promise.all([
    db.from('collection_cards')
      .select(`id, level, xp, copies, acquired_at, card_definitions!inner ( catalogue_version_id, ${CARD_SELECT} )`)
      .eq('profile_id', found.id)
      .eq('card_definitions.card_key', key)
      .order('acquired_at', { ascending: false })
      .limit(10),
    db.from('catalogue_versions').select('id').eq('is_active', true).maybeSingle(),
  ]);

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  const list = (rows || []).filter((r: any) => r.card_definitions);
  const row: any = list.find((r: any) => r.card_definitions.catalogue_version_id === (active as any)?.id) || list[0];

  if (!row) {
    throw createError({ statusCode: 404, statusMessage: `${found.displayName} does not hold that card.` });
  }

  return {
    manager: found,
    isSelf: found.id === manager.id,
    held: {
      id: row.id,
      level: row.level,
      xp: row.xp,
      copies: row.copies,
      acquiredAt: row.acquired_at,
      card: toCard(row.card_definitions),
    },
  };
});
