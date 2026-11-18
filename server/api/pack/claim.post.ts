import { serverSupabaseUser, serverSupabaseServiceRole } from '#supabase/server';
import { configuredWindow } from '~~/server/utils/packDay';
import { rollPack, applyXp, DUPLICATE_XP } from '~~/server/utils/roll';
import { CARD_SELECT, toCard } from '~~/shared/cardShape';

/**
 * Claim today's pack.
 *
 * The concurrency story is the unique index on (profile_id, pack_day): the row is inserted
 * *before* anything is rolled, so two taps race on the insert and exactly one proceeds. A
 * claim whose roll did not finish has settled_at = null and is resumed on the next call,
 * which is why the insert and the roll are not wrapped in one optimistic check.
 *
 * Everything here runs with the service-role key. There is no client-side insert policy on
 * collection_cards, so this endpoint is the only way a card can enter a collection.
 */
export default defineEventHandler(async (event) => {
  const user = await serverSupabaseUser(event);
  if (!user) throw createError({ statusCode: 401, statusMessage: 'Sign in first' });

  const config = useRuntimeConfig();
  const db = serverSupabaseServiceRole(event);
  const window = configuredWindow(config);

  const { data: active } = await db
    .from('catalogue_versions')
    .select('id, semver')
    .eq('is_active', true)
    .maybeSingle();

  if (!active) {
    throw createError({
      statusCode: 503,
      statusMessage: 'No active catalogue. Run scripts/push-catalogue.mjs.',
    });
  }

  // 1. Reserve the day.
  const { data: reserved, error: reserveError } = await db
    .from('pack_claims')
    .insert({ profile_id: user.id, pack_day: window.packDay })
    .select('id, settled_at')
    .single();

  let claimId = reserved?.id as string | undefined;

  if (reserveError) {
    if (reserveError.code !== '23505') {
      throw createError({ statusCode: 500, statusMessage: reserveError.message });
    }
    const { data: existing } = await db
      .from('pack_claims')
      .select('id, settled_at')
      .eq('profile_id', user.id)
      .eq('pack_day', window.packDay)
      .single();

    if (existing?.settled_at) {
      throw createError({ statusCode: 409, statusMessage: 'Today’s pack is already open' });
    }
    claimId = existing?.id;
  }

  if (!claimId) throw createError({ statusCode: 500, statusMessage: 'Could not reserve the pack' });

  // 2. Roll.
  const result = await rollPack({ db, profileId: user.id, catalogueVersionId: active.id });

  // 3. Grant, or feed the duplicate into XP (docs/02 section 5.3).
  let xpAwarded = 0;
  if (result.wasDuplicate) {
    const { data: held } = await db
      .from('collection_cards')
      .select('id, level, xp, copies')
      .eq('profile_id', user.id)
      .eq('card_definition_id', result.cardId)
      .single();

    if (held) {
      const next = applyXp(held.level, held.xp, DUPLICATE_XP);
      xpAwarded = DUPLICATE_XP;
      await db.from('collection_cards')
        .update({ level: next.level, xp: next.xp, copies: held.copies + 1 })
        .eq('id', held.id);
    }
  } else {
    await db.from('collection_cards').insert({
      profile_id: user.id,
      card_definition_id: result.cardId,
      source: 'PACK',
    });
  }

  // 4. Pity.
  const { data: pityRow } = await db
    .from('pity_counters')
    .select('since_legendary, since_icon, packs_opened')
    .eq('profile_id', user.id)
    .maybeSingle();

  const prev = pityRow || { since_legendary: 0, since_icon: 0, packs_opened: 0 };
  const isLegendaryPlus = result.band === 'LEGENDARY' || result.band === 'ICON';

  await db.from('pity_counters').upsert({
    profile_id: user.id,
    since_legendary: isLegendaryPlus ? 0 : prev.since_legendary + 1,
    since_icon: result.band === 'ICON' ? 0 : prev.since_icon + 1,
    packs_opened: prev.packs_opened + 1,
    updated_at: new Date().toISOString(),
  });

  // 5. Settle the claim and hand back the card.
  await db.from('pack_claims').update({
    card_definition_id: result.cardId,
    rarity: result.band,
    was_duplicate: result.wasDuplicate,
    xp_awarded: xpAwarded,
    settled_at: new Date().toISOString(),
  }).eq('id', claimId);

  const { data: row } = await db
    .from('card_definitions')
    .select(CARD_SELECT)
    .eq('id', result.cardId)
    .single();

  return {
    packDay: window.packDay,
    rarity: result.band,
    forcedBy: result.forcedBy,
    wasDuplicate: result.wasDuplicate,
    xpAwarded,
    card: row ? toCard(row as any) : null,
  };
});
