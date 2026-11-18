/**
 * Sample cards — one per rarity band, for design work.
 *
 * IMPORTANT: every number below is an ILLUSTRATIVE PLACEHOLDER chosen to exercise the
 * five rarity treatments. None of it is derived data. Real cards come from the pipeline
 * in docs/03-data-pipeline.md, which computes sub-stats from Oracle's Elixir match rows
 * and writes a real provenance string. The player-seasons are real; the stats are not.
 *
 * `key` on each pool entry is the Data Dragon champion id, which is what the real schema
 * stores (champion_key). It is not always derivable from the display name — "LeBlanc" is
 * `Leblanc`, "Lee Sin" is `LeeSin` — so the pipeline carries it explicitly and so does this.
 *
 * `artFocus` is the object-position for the splash crop. Data Dragon splashes are 1215x717
 * and the art window is narrower, so the crop is horizontal: the X value is what matters.
 */

export const SAMPLE_PROVENANCE =
  'SAMPLE CARD — illustrative placeholder values, not derived from match data. '
  + 'Production cards are minted by the LOM data pipeline and carry their real source, '
  + 'game count and catalogue version here. Champion art: Riot Data Dragon.';

export const SAMPLE_CARDS = [
  {
    cardKey: 'vetheo-2021',
    playerName: 'Vetheo',
    season: 2021,
    team: 'Misfits',
    region: 'LEC',
    role: 'MID',
    ovr: 66,
    rarity: 'COMMON',
    accolades: [],
    artFocus: '52% 50%',
    subStats: { laning: 64, teamfight: 69, mechanics: 71, macro: 58, vision: 55, consistency: 52 },
    championPool: [
      { champion: 'Syndra', key: 'Syndra', games: 14, mastery: 72, winrate: 0.5 },
      { champion: 'Akali', key: 'Akali', games: 9, mastery: 64, winrate: 0.44 },
      { champion: 'Orianna', key: 'Orianna', games: 7, mastery: 58, winrate: 0.57 },
      { champion: 'Sylas', key: 'Sylas', games: 4, mastery: 46, winrate: 0.5 },
    ],
    seasonSummary: { Games: 34, KDA: '3.1', 'GD@15': '-102', DPM: 534 },
    provenance: SAMPLE_PROVENANCE,
  },
  {
    cardKey: 'wunder-2018',
    playerName: 'Wunder',
    season: 2018,
    team: 'G2 Esports',
    region: 'LEC',
    role: 'TOP',
    ovr: 75,
    rarity: 'RARE',
    accolades: [],
    artFocus: '44% 50%',
    subStats: { laning: 78, teamfight: 74, mechanics: 76, macro: 71, vision: 61, consistency: 73 },
    championPool: [
      { champion: 'Aatrox', key: 'Aatrox', games: 21, mastery: 86, winrate: 0.62 },
      { champion: 'Jayce', key: 'Jayce', games: 16, mastery: 81, winrate: 0.56 },
      { champion: 'Sion', key: 'Sion', games: 11, mastery: 76, winrate: 0.64 },
      { champion: 'Urgot', key: 'Urgot', games: 6, mastery: 59, winrate: 0.5 },
    ],
    seasonSummary: { Games: 61, KDA: '3.4', 'GD@15': '+214', DPM: 492 },
    provenance: SAMPLE_PROVENANCE,
  },
  {
    cardKey: 'canyon-2022',
    playerName: 'Canyon',
    season: 2022,
    team: 'DWG KIA',
    region: 'LCK',
    role: 'JNG',
    ovr: 83,
    rarity: 'EPIC',
    accolades: ['DOMESTIC_TITLE'],
    artFocus: '48% 50%',
    subStats: { laning: 74, teamfight: 85, mechanics: 88, macro: 89, vision: 76, consistency: 82 },
    championPool: [
      { champion: 'Viego', key: 'Viego', games: 28, mastery: 94, winrate: 0.64 },
      { champion: 'Lee Sin', key: 'LeeSin', games: 22, mastery: 90, winrate: 0.59 },
      { champion: 'Graves', key: 'Graves', games: 17, mastery: 85, winrate: 0.65 },
      { champion: 'Hecarim', key: 'Hecarim', games: 9, mastery: 71, winrate: 0.56 },
    ],
    seasonSummary: { Games: 78, KDA: '4.2', 'GD@15': '+173', DPM: 418 },
    provenance: SAMPLE_PROVENANCE,
  },
  {
    cardKey: 'ruler-2023',
    playerName: 'Ruler',
    season: 2023,
    team: 'JD Gaming',
    region: 'LPL',
    role: 'BOT',
    ovr: 90,
    rarity: 'LEGENDARY',
    accolades: ['DOMESTIC_TITLE', 'FINALS_MVP'],
    artFocus: '44% 50%',
    subStats: { laning: 88, teamfight: 95, mechanics: 91, macro: 80, vision: 66, consistency: 92 },
    championPool: [
      { champion: 'Aphelios', key: 'Aphelios', games: 31, mastery: 95, winrate: 0.68 },
      { champion: 'Zeri', key: 'Zeri', games: 24, mastery: 92, winrate: 0.63 },
      { champion: 'Jinx', key: 'Jinx', games: 19, mastery: 90, winrate: 0.74 },
      { champion: "Kai'Sa", key: 'Kaisa', games: 13, mastery: 83, winrate: 0.62 },
    ],
    seasonSummary: { Games: 92, KDA: '6.1', 'GD@15': '+288', DPM: 681 },
    provenance: SAMPLE_PROVENANCE,
  },
  {
    cardKey: 'faker-2016',
    playerName: 'Faker',
    season: 2016,
    team: 'SKT T1',
    region: 'LCK',
    role: 'MID',
    ovr: 97,
    rarity: 'ICON',
    accolades: ['WORLDS_WINNER', 'FINALS_MVP'],
    artFocus: '50% 50%',
    subStats: { laning: 94, teamfight: 96, mechanics: 98, macro: 93, vision: 79, consistency: 97 },
    championPool: [
      { champion: 'Ryze', key: 'Ryze', games: 34, mastery: 97, winrate: 0.71 },
      { champion: 'Viktor', key: 'Viktor', games: 26, mastery: 95, winrate: 0.73 },
      { champion: 'Cassiopeia', key: 'Cassiopeia', games: 15, mastery: 92, winrate: 0.8 },
      { champion: 'LeBlanc', key: 'Leblanc', games: 12, mastery: 89, winrate: 0.67 },
    ],
    seasonSummary: { Games: 88, KDA: '5.8', 'GD@15': '+341', DPM: 596 },
    provenance: SAMPLE_PROVENANCE,
  },
];
