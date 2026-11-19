/**
 * Turning a rolled pack into things a manager owns.
 *
 * Shared by the free daily pack and by anything bought, so a card arrives the same way
 * whatever it was paid for, and there is one place where cards enter a collection.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { applyXp, DUPLICATE_XP, DUPLICATE_CREDITS, type PackType, type Pick, type PityState } from './roll';
import { CARD_SELECT, toCard } from '~~/shared/cardShape';

export interface SettledCard {
  slot: number;
  rarity: string;
  wasDuplicate: boolean;
  xpAwarded: number;
  creditsAwarded: number;
  forcedBy: Pick['forcedBy'];
  card: ReturnType<typeof toCard> | null;
}

/**
 * Move Credits, or refuse.
 *
 * Always through the SQL function: it locks the profile row, so two taps cannot both read
 * the same balance and both pay for a pack. A failure here is a real failure — a spend that
 * silently clamps to zero is a free pack.
 */
export async function moveCredits(
  db: SupabaseClient,
  profileId: string,
  delta: number,
  reason: string,
  refId?: string,
): Promise<number> {
  const { data, error } = await db.rpc('grant_credits', {
    p_profile: profileId,
    p_delta: delta,
    p_reason: reason,
    p_ref: refId ?? null,
  });
  if (error) throw error;
  return data as number;
}

/**
 * Write a rolled pack down: the opening, the cards, the XP and Credits a duplicate pays,
 * and the manager's pity after it.
 *
 * Deliberately not wrapped in a transaction, because PostgREST has none to offer. The order
 * is chosen so the failure modes are survivable: the opening row exists before any card is
 * granted, so a half-written pack is visible rather than invisible, and pity is written last
 * so a crash cannot advance a counter for cards nobody received.
 */
export async function persistOpening(opts: {
  db: SupabaseClient;
  profileId: string;
  pack: PackType;
  picks: Pick[];
  pity: PityState;
  packDay: string | null;
  creditsSpent: number;
}): Promise<{ openingId: string; cards: SettledCard[]; creditsEarned: number }> {
  const { db, profileId, pack, picks, pity, packDay, creditsSpent } = opts;

  const { data: opening, error: openingError } = await db
    .from('pack_openings')
    .insert({
      profile_id: profileId,
      pack_type: pack.key,
      pack_day: packDay,
      credits_spent: creditsSpent,
    })
    .select('id')
    .single();

  if (openingError || !opening) {
    throw createError({ statusCode: 500, statusMessage: openingError?.message || 'Could not open the pack' });
  }

  const cards: SettledCard[] = [];
  let creditsEarned = 0;

  for (const pick of picks) {
    let xpAwarded = 0;
    let creditsAwarded = 0;

    if (pick.wasDuplicate) {
      // docs/02 section 5.3: a duplicate is never a second copy you can field, it is XP on
      // the card you already have — plus Credits, see DUPLICATE_CREDITS.
      const { data: held } = await db
        .from('collection_cards')
        .select('id, level, xp, copies')
        .eq('profile_id', profileId)
        .eq('card_definition_id', pick.cardId)
        .maybeSingle();

      if (held) {
        const next = applyXp(held.level, held.xp, DUPLICATE_XP);
        xpAwarded = DUPLICATE_XP;
        await db.from('collection_cards')
          .update({ level: next.level, xp: next.xp, copies: held.copies + 1 })
          .eq('id', held.id);
      }
      creditsAwarded = DUPLICATE_CREDITS[pick.band] ?? 0;
      if (creditsAwarded > 0) {
        await moveCredits(db, profileId, creditsAwarded, 'DUPLICATE', opening.id);
        creditsEarned += creditsAwarded;
      }
    } else {
      // A pack can only ever add a card it rolled; there is no client path into this table.
      const { error } = await db.from('collection_cards').insert({
        profile_id: profileId,
        card_definition_id: pick.cardId,
        source: 'PACK',
      });
      // A duplicate detected only at insert time means the manager pulled the same card in
      // two packs opened at once. Falling back to the duplicate reward is better than losing
      // the slot entirely.
      if (error && error.code === '23505') {
        creditsAwarded = DUPLICATE_CREDITS[pick.band] ?? 0;
        if (creditsAwarded > 0) {
          await moveCredits(db, profileId, creditsAwarded, 'DUPLICATE', opening.id);
          creditsEarned += creditsAwarded;
        }
        pick.wasDuplicate = true;
      } else if (error) {
        throw createError({ statusCode: 500, statusMessage: error.message });
      }
    }

    await db.from('pack_opening_cards').insert({
      opening_id: opening.id,
      slot: pick.slot,
      card_definition_id: pick.cardId,
      rarity: pick.band,
      was_duplicate: pick.wasDuplicate,
      xp_awarded: xpAwarded,
      credits_awarded: creditsAwarded,
    });

    const { data: row } = await db
      .from('card_definitions')
      .select(CARD_SELECT)
      .eq('id', pick.cardId)
      .single();

    cards.push({
      slot: pick.slot,
      rarity: pick.band,
      wasDuplicate: pick.wasDuplicate,
      xpAwarded,
      creditsAwarded,
      forcedBy: pick.forcedBy,
      card: row ? toCard(row as any) : null,
    });
  }

  await db.from('pity_counters').upsert({
    profile_id: profileId,
    since_legendary: pity.since_legendary,
    since_icon: pity.since_icon,
    packs_opened: pity.packs_opened,
    updated_at: new Date().toISOString(),
  });

  return { openingId: opening.id, cards, creditsEarned };
}
