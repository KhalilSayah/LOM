/**
 * Turning a rolled pack into things a manager owns.
 *
 * Shared by the free daily pack, by anything bought and by gifts, so a card arrives the same
 * way whatever it was paid for, and there is one place where cards enter a collection.
 *
 * The roll happens here in TypeScript, because it has no side effects. Everything that does
 * — the spend, the cards, duplicate XP and Credits, pity, and the claim or gift it settles —
 * happens inside one SQL function, `lom_open_pack` (migration 0019), in one transaction. The
 * old sequence of PostgREST writes could stop half way: a daily pack rolled twice, a bought
 * pack paid for and never received, a gift handed back after some of its cards had arrived.
 * One transaction has no half way.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { DUPLICATE_XP, DUPLICATE_CREDITS, type PackType, type Pick, type Rarity } from './roll';
import { CARD_SELECT, toCard } from '~~/shared/cardShape';
import { bankableDays, packDayOf, addDays, type PackWindow } from './packDay';

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
 * the same balance and both pay for something. A failure here is a real failure — a spend
 * that silently clamps to zero is a free pack.
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

export const PACK_TYPE_SELECT = 'key, name, price, slots, one_per_role, weights, floor_band, max_band, daily_limit';

export async function loadPackType(db: SupabaseClient, key: string, activeOnly = false): Promise<PackType | null> {
  let q = db.from('pack_types').select(PACK_TYPE_SELECT).eq('key', key);
  if (activeOnly) q = q.eq('is_active', true);
  const { data } = await q.maybeSingle();
  return (data as unknown as PackType) ?? null;
}

export async function activeCatalogueId(db: SupabaseClient): Promise<string> {
  const { data } = await db.from('catalogue_versions').select('id').eq('is_active', true).maybeSingle();
  if (!data) {
    throw createError({ statusCode: 503, statusMessage: 'No active catalogue. Run scripts/push-catalogue.mjs.' });
  }
  return data.id;
}

/** Card definitions by id, in the shape the client renders. */
export async function cardsById(db: SupabaseClient, ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, ReturnType<typeof toCard>>();
  if (!unique.length) return out;
  const { data } = await db.from('card_definitions').select(CARD_SELECT).in('id', unique);
  for (const row of (data || []) as any[]) out.set(row.id, toCard(row));
  return out;
}

export type OpenSource = 'DAILY' | 'BUY' | 'GIFT';

export interface OpenResult {
  status: 'opened' | 'already' | 'missing' | 'bonus_taken';
  openingId?: string;
  spent: number;
  creditsEarned: number;
  credits: number;
  cards: SettledCard[];
}

/**
 * Write a rolled pack down, all or nothing.
 *
 * Whether a slot is a duplicate is decided by the database at the moment of granting, not
 * by what the roll saw: two packs opened at once can pull the same new card, and the second
 * one must pay XP and Credits for it rather than fail. XP reported is what the card actually
 * gained, which is less than DUPLICATE_XP for a card at the level cap.
 */
export async function openPack(opts: {
  db: SupabaseClient;
  profileId: string;
  source: OpenSource;
  pack: PackType;
  picks: Pick[];
  /** The day the opening counts against: a daily claim's own day, or today for a bought pack. */
  packDay: string | null;
  /** Daily only: the pack day it is actually being opened on. */
  openedDay?: string | null;
  giftId?: string | null;
  /** Daily only: this is the streak's day-seven pack. */
  bonus?: boolean;
}): Promise<OpenResult> {
  const { db, profileId, source, pack, picks } = opts;

  const plan = picks.map((p) => ({
    slot: p.slot,
    card: p.cardId,
    band: p.band,
    dup_xp: DUPLICATE_XP,
    dup_credits: DUPLICATE_CREDITS[p.band as Rarity] ?? 0,
  }));

  const { data, error } = await db.rpc('lom_open_pack', {
    p_profile: profileId,
    p_source: source,
    p_pack_type: pack.key,
    p_plan: plan,
    p_pack_day: opts.packDay,
    p_opened_day: opts.openedDay ?? null,
    p_gift: opts.giftId ?? null,
    p_bonus: Boolean(opts.bonus),
  });

  if (error) {
    const msg = String(error.message || '');
    if (msg.includes('lom:limit')) {
      throw createError({
        statusCode: 429,
        statusMessage: `You have opened today's ${pack.name.toLowerCase()} allowance. Try again after the day rolls.`,
      });
    }
    if (msg.includes('lom:funds')) {
      throw createError({ statusCode: 402, statusMessage: `Not enough Credits for the ${pack.name.toLowerCase()}.` });
    }
    if (msg.includes('lom:no_pack')) throw createError({ statusCode: 404, statusMessage: 'No such pack' });
    if (error.code === 'PGRST202' || msg.includes('lom_open_pack')) {
      console.error('[packs] lom_open_pack failed', { code: error.code, message: msg });
      throw createError({
        statusCode: 503,
        statusMessage: error.code === 'PGRST202'
          ? 'Packs are being upgraded. Run supabase/migrations/0019_economy_integrity.sql.'
          : 'The pack did not open. Nothing was spent; try again.',
      });
    }
    throw createError({ statusCode: 500, statusMessage: 'The pack did not open. Nothing was spent; try again.' });
  }

  const res = data as any;
  if (res?.status !== 'opened') {
    return { status: res?.status ?? 'already', spent: 0, creditsEarned: 0, credits: 0, cards: [] };
  }

  const rows = (res.cards || []) as Array<{
    slot: number; card: string; band: string; was_duplicate: boolean; xp_awarded: number; credits_awarded: number;
  }>;
  const defs = await cardsById(db, rows.map((r) => r.card));
  const forced = new Map(picks.map((p) => [p.slot, p.forcedBy]));

  return {
    status: 'opened',
    openingId: res.opening_id,
    spent: res.spent ?? 0,
    creditsEarned: res.credits_earned ?? 0,
    credits: res.credits ?? 0,
    cards: rows.map((r) => ({
      slot: r.slot,
      rarity: r.band,
      wasDuplicate: Boolean(r.was_duplicate),
      xpAwarded: r.xp_awarded ?? 0,
      creditsAwarded: r.credits_awarded ?? 0,
      forcedBy: forced.get(r.slot) ?? null,
      card: defs.get(r.card) ?? null,
    })),
  };
}

// --- the daily pack: what is waiting, and the streak -------------------------------

/** Every seventh day in a row, the first daily pack opened is one of these. */
export const STREAK_LENGTH = 7;
export const STREAK_FLOOR: Rarity = 'EPIC';

export interface DailyState {
  /** Pack days whose pack is still waiting, oldest first. At most BANK_MAX. */
  bank: string[];
  /** Waiting days that already have a reserved, unfinished claim (left by older code). */
  reserved: string[];
  /** Consecutive pack days, ending today or yesterday, on which a daily pack was opened. */
  streak: number;
  openedToday: boolean;
  /** The next daily pack opened carries the streak upgrade. */
  nextIsBonus: boolean;
  /** Where today sits in the seven: 1..7. The day the next opening would be, if not yet opened today. */
  streakDay: number;
  /** Today's openings, most recent first. */
  today: Array<{
    packDay: string;
    openingId: string | null;
    cardId: string | null;
    rarity: string | null;
    wasDuplicate: boolean;
    xpAwarded: number;
    streakBonus: boolean;
  }>;
}

/**
 * Where a manager stands with the daily pack.
 *
 * Banking counts `pack_day` (which day a pack belongs to); the streak counts `opened_day`
 * (which day the manager actually showed up). Opening a banked pack late keeps the pack but
 * not the streak: a missed day resets the count, and nothing else is lost.
 */
export async function dailyState(db: SupabaseClient, profileId: string, window: PackWindow): Promise<DailyState> {
  const today = window.packDay;
  // A year back is plenty for any streak, and bounds the read.
  const since = addDays(today, -370);

  const [{ data: profile }, { data: claims, error }] = await Promise.all([
    db.from('profiles').select('created_at').eq('id', profileId).maybeSingle(),
    db.from('pack_claims')
      .select('pack_day, opened_day, settled_at, claimed_at, opening_id, card_definition_id, rarity, was_duplicate, xp_awarded, streak_bonus')
      .eq('profile_id', profileId)
      .gte('pack_day', since)
      .order('settled_at', { ascending: false }),
  ]);

  if (error) {
    console.error('[packs] could not read daily claims', { code: error.code, message: error.message });
    throw createError({
      statusCode: 503,
      statusMessage: 'The daily pack is being upgraded. Run supabase/migrations/0019_economy_integrity.sql.',
    });
  }

  const firstDay = profile?.created_at
    ? packDayOf(new Date(profile.created_at), window.hour, window.timeZone)
    : null;

  const settled = (claims || []).filter((c: any) => c.settled_at);
  const settledDays = new Set(settled.map((c: any) => String(c.pack_day)));
  const openedDays = new Set(settled.map((c: any) => String(c.opened_day ?? c.pack_day)));

  const bank = bankableDays(today, firstDay).filter((d) => !settledDays.has(d));
  const reservedDays = new Set((claims || []).filter((c: any) => !c.settled_at).map((c: any) => String(c.pack_day)));

  const openedToday = openedDays.has(today);
  let cursor = openedToday ? today : addDays(today, -1);
  let streak = 0;
  while (openedDays.has(cursor) && streak < 400) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }

  const upcoming = openedToday ? streak : streak + 1;
  const streakDay = ((Math.max(1, upcoming) - 1) % STREAK_LENGTH) + 1;

  return {
    bank,
    reserved: bank.filter((d) => reservedDays.has(d)),
    streak,
    openedToday,
    nextIsBonus: !openedToday && upcoming % STREAK_LENGTH === 0,
    streakDay,
    today: settled
      .filter((c: any) => String(c.opened_day ?? c.pack_day) === today)
      .map((c: any) => ({
        packDay: String(c.pack_day),
        openingId: c.opening_id ?? null,
        cardId: c.card_definition_id ?? null,
        rarity: c.rarity ?? null,
        wasDuplicate: Boolean(c.was_duplicate),
        xpAwarded: c.xp_awarded ?? 0,
        streakBonus: Boolean(c.streak_bonus),
      })),
  };
}
