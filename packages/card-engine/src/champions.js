/**
 * Champion identity: the one table that maps what people type and what sources write to
 * the id Riot files art under, and back to the name a person reads.
 *
 * Two directions, one list, so they cannot drift apart:
 *   championKey("Lee Sin")      -> "LeeSin"      the Data Dragon id, used for art and as
 *   championKey("Wukong")       -> "MonkeyKing"  the champion's identity everywhere else
 *   championName("LeeSin")      -> "Lee Sin"     what a card, a pool row or a search shows
 *   championName("MonkeyKing")  -> "Wukong"
 *
 * Everything that needs either direction imports it from here: the asset resolver, the
 * card renderer, the seed and real catalogue builders, and the server's champion-role
 * table. Before this existed the asset layer and the seed script each carried a partial
 * copy, and the seed shipped both "Wukong" and "MonkeyKing" as two different champions.
 *
 * Pure data and two small functions, no DOM, so Node scripts and Nitro import it directly.
 */

/**
 * Display name -> Data Dragon id, for every champion whose id is not just the display
 * name with spaces and punctuation stripped, plus every champion whose name has a space
 * or punctuation in it (so championName() can put them back).
 *
 * The rule-breakers are the interesting rows. For 164 of the 173 champions the id is the
 * stripped name: "Rek'Sai" -> RekSai, "K'Sante" -> KSante. For nine it is not: Riot folded
 * the letter after the apostrophe to lower case in some names ("Kha'Zix" -> Khazix) and kept
 * it in others ("Kog'Maw" -> KogMaw), and three are renames the ids never followed.
 *
 * Getting one wrong is silent — the URL is well formed, the CDN answers 403, the card
 * falls back to generated art — so this is checked against the live CDN, not reasoned.
 */
const CHAMPIONS = [
  // [display name, Data Dragon id]
  ['Aurelion Sol', 'AurelionSol'],
  ["Bel'Veth", 'Belveth'],
  ["Cho'Gath", 'Chogath'],
  ['Dr. Mundo', 'DrMundo'],
  ['Jarvan IV', 'JarvanIV'],
  ["K'Sante", 'KSante'],
  ["Kai'Sa", 'Kaisa'],
  ["Kha'Zix", 'Khazix'],
  ["Kog'Maw", 'KogMaw'],
  ['LeBlanc', 'Leblanc'],
  ['Lee Sin', 'LeeSin'],
  ['Master Yi', 'MasterYi'],
  ['Miss Fortune', 'MissFortune'],
  ['Nunu & Willump', 'Nunu'],
  ["Rek'Sai", 'RekSai'],
  ['Renata Glasc', 'Renata'],
  ['Tahm Kench', 'TahmKench'],
  ['Twisted Fate', 'TwistedFate'],
  ["Vel'Koz", 'Velkoz'],
  ['Wukong', 'MonkeyKing'],
  ['Xin Zhao', 'XinZhao'],
  ['Fiddlesticks', 'Fiddlesticks'],
];

const squash = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '');

/**
 * Loose key (lower case, punctuation stripped) -> Data Dragon id. Keyed loosely so the
 * lookup catches the display name ("Cho'Gath"), the id ("Chogath"), and any key derived
 * from the name the old way ("ChoGath") — which is what keeps rows already in the
 * database rendering after the rule changed.
 */
export const DDRAGON_IDS = {};
/** Data Dragon id -> display name. */
export const CHAMPION_NAMES = {};

for (const [name, id] of CHAMPIONS) {
  DDRAGON_IDS[squash(name).toLowerCase()] = id;
  DDRAGON_IDS[id.toLowerCase()] = id;
  CHAMPION_NAMES[id] = name;
}
// Old names the ids or sources still use.
DDRAGON_IDS.nunuwillump = 'Nunu';
DDRAGON_IDS.renataglasc = 'Renata';
DDRAGON_IDS.monkeyking = 'MonkeyKing';

/**
 * Display name or loose key -> the Data Dragon id. Idempotent: an id passed through again
 * comes back unchanged, so everything can be canonicalised as often as is convenient.
 * @param {string|null|undefined} name
 */
export function championKey(name) {
  const stripped = squash(name);
  return DDRAGON_IDS[stripped.toLowerCase()] || stripped;
}

/**
 * Any key or name -> the name a person reads. "LeeSin" -> "Lee Sin", "MonkeyKing" ->
 * "Wukong", "Ahri" -> "Ahri". A name already in display form comes back as it is.
 * @param {string|null|undefined} keyOrName
 */
export function championName(keyOrName) {
  if (!keyOrName) return '';
  return CHAMPION_NAMES[championKey(keyOrName)] || String(keyOrName);
}
