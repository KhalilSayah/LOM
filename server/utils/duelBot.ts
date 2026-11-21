import type { SupabaseClient } from '@supabase/supabase-js';
import { SLOTS, type Slot } from '~~/shared/draft';
import { CARD_SELECT, toCard } from '~~/shared/cardShape';
import type { Difficulty } from '~~/shared/duelRoom';
import { agentProfile, type DuelCard, type Lineup } from './duel';

/**
 * A five for the agent to field when nobody else is searching.
 *
 * The queue is the right way to play and an empty queue is the normal state of a game with
 * no players yet. Waiting alone is the one outcome that teaches somebody never to press the
 * button again, so after twenty seconds of searching there is always a game — against the
 * auto-draft agent that already exists for absences (docs/05 section 4).
 *
 * Two decisions worth defending.
 *
 * The bot has no profile and no collection. `duels.opponent_id` is null on a bot duel
 * rather than pointing at a seeded account, because a seeded account would show up in
 * discovery, hold a handle, own cards, and be counted every time anyone asks how many
 * managers there are. A null is honest; a fake manager is a lie the whole app has to
 * remember.
 *
 * Its five are drawn from the catalogue near the player's own strength, not from a fixed
 * roster. A constant opponent is solved once and then boring, and an opponent built from
 * the strongest cards in the catalogue is just a wall. Matching the player's own average
 * means the bot gets better as your collection does, which is the only version of this
 * that stays worth playing.
 */

/** How far either side of the player's average the bot's cards may be drawn. */
const OVR_BAND = 4;

export async function botLineup(
  db: SupabaseClient,
  catalogueVersionId: string,
  against: Lineup,
  seed: string,
  /**
   * Practice only. Moves the band a few OVR either side of the player's average, because a
   * harder agent drafting well with a weaker five is still a soft match (AGENT_PROFILES).
   * Left out, the band sits on the player's average exactly as it always has.
   */
  difficulty?: Difficulty,
): Promise<Lineup> {
  const filled = SLOTS.map((s) => against[s]).filter(Boolean) as DuelCard[];
  const shift = difficulty ? agentProfile(difficulty).ovrShift : 0;
  const target = (filled.length
    ? Math.round(filled.reduce((sum, c) => sum + c.ovr, 0) / filled.length)
    : 70) + shift;

  const rand = seeded(seed);
  const out = {} as Lineup;

  // One query per slot rather than one for everything: a role filter plus a narrow OVR
  // band is an index seek on card_definitions_band_idx, and the alternative is pulling the
  // whole catalogue into memory to throw almost all of it away.
  for (const slot of SLOTS) {
    out[slot] = await pickOne(db, catalogueVersionId, slot, target, rand);
  }
  return out;
}

async function pickOne(
  db: SupabaseClient,
  catalogueVersionId: string,
  slot: Slot,
  target: number,
  rand: () => number,
): Promise<DuelCard | null> {
  // Widen the band until something comes back. A catalogue with three mid laners in it
  // should still produce a bot, and the seed catalogue is exactly that small.
  for (const band of [OVR_BAND, OVR_BAND * 3, 99]) {
    const { data } = await db
      .from('card_definitions')
      .select(CARD_SELECT)
      .eq('catalogue_version_id', catalogueVersionId)
      .eq('role', slot)
      .gte('ovr', Math.max(40, target - band))
      .lte('ovr', Math.min(99, target + band))
      .limit(60);

    if (data?.length) {
      const row = data[Math.floor(rand() * data.length)]!;
      return asDuelCard(row, slot);
    }
  }
  return null;
}

function asDuelCard(row: any, slot: Slot): DuelCard {
  const card = toCard(row);
  const pool: Record<string, number> = {};
  const poolNames: Record<string, string> = {};
  for (const entry of card.championPool || []) {
    pool[entry.key] = entry.mastery;
    poolNames[entry.key] = entry.champion;
  }
  return {
    cardKey: card.cardKey,
    name: card.playerName,
    slot,
    ovr: card.ovr,
    // Level 1 on purpose. The agent plays a competent draft (docs/05 section 4) and should
    // not also be handed the levelling a player spent weeks of packs on.
    level: 1,
    rarity: card.rarity,
    season: card.season ?? null,
    team: card.team ?? null,
    region: card.region ?? null,
    subStats: card.subStats || {},
    pool,
    poolNames,
    artChampionKey: card.artChampionKey ?? null,
  };
}

function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return h / 4294967296;
  };
}
