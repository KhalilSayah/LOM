/**
 * One card shape, from Postgres rows to what @lom/card-engine renders.
 *
 * The engine's normaliseCard() fills gaps, but it expects `championPool[].champion` and
 * `.key`, while the database stores `champion_name` and `champion_key`. This is the only
 * place that translation happens — the client and the pack route both call it, so a card
 * from a pack and a card from the collection are the same object.
 */

export interface PoolRow {
  champion_key: string;
  champion_name: string;
  games: number;
  winrate: number | string;
  mastery: number;
  slot?: number;
}

export interface CardRow {
  card_key: string;
  player_name: string;
  season: number | null;
  team: string | null;
  region: string | null;
  role: string | null;
  ovr: number;
  rarity: string;
  sub_stats: Record<string, number>;
  accolades: string[];
  season_summary: Record<string, string | number>;
  provenance: Record<string, unknown>;
  art_champion_key: string | null;
  art_focus: string | null;
  card_champion_pool?: PoolRow[] | null;
  pool?: PoolRow[] | null;
}

/**
 * `level` is the owned copy's, not the definition's: pass it wherever the card is a held
 * one (roster, sandbox), so anything rating the card through @lom/core sees the same level the
 * match does. A definition on its own is level 1.
 */
export function toCard(row: CardRow, level = 1) {
  const pool = (row.card_champion_pool || row.pool || [])
    .slice()
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));

  return {
    cardKey: row.card_key,
    playerName: row.player_name,
    season: row.season ?? undefined,
    team: row.team ?? undefined,
    region: row.region ?? undefined,
    role: row.role ?? 'MID',
    ovr: row.ovr,
    level: Math.max(1, Number(level) || 1),
    rarity: row.rarity,
    accolades: row.accolades || [],
    subStats: row.sub_stats,
    championPool: pool.map((p) => ({
      champion: p.champion_name,
      key: p.champion_key,
      games: p.games,
      winrate: Number(p.winrate),
      mastery: p.mastery,
    })),
    seasonSummary: row.season_summary || {},
    provenance: provenanceLine(row.provenance),
    artChampionKey: row.art_champion_key,
    artFocus: row.art_focus,
  };
}

/** The back of every card has to say where its numbers came from (docs/09 section 5). */
export function provenanceLine(prov: Record<string, any> | null | undefined): string {
  if (!prov) return '';
  if (typeof prov === 'string') return prov;
  if (prov.note) return String(prov.note);
  if (prov.source === 'SEED') return 'Seed catalogue — editorial rating, not derived from match data.';
  return '';
}

export const CARD_SELECT = `
  id, card_key, player_name, season, team, region, role, ovr, rarity,
  sub_stats, accolades, season_summary, provenance, art_champion_key, art_focus,
  card_champion_pool ( champion_key, champion_name, games, winrate, mastery, slot )
`;
