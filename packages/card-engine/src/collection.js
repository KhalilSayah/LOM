/**
 * Collection helpers: search, sort and sets.
 *
 * Pure functions over the normalised card shape, shared by your Cards screen, a friend's
 * collection and the sets view, so "faker 2016" finds the same card on all three. No DOM,
 * no Vue, so a throwaway Node script can check them.
 */

import { championName } from './champions.js';

/** Lowest to highest. */
export const RARITY_ORDER = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON'];

const bandRank = (r) => RARITY_ORDER.indexOf(String(r || '').toUpperCase());

/**
 * Text as search compares it: no case, no accents, no spaces, no punctuation.
 * "Lee Sin", "leesin" and "LEE-SIN" all become "leesin"; "Kha'Zix" becomes "khazix".
 * @param {unknown} s
 */
export function normaliseText(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * The query, as the words that must each match. Split on whitespace and the separators
 * people type between words, so "faker 2016", "faker, 2016" and "t1/2023" are two words.
 * @param {string} q
 * @returns {string[]}
 */
export function queryTokens(q) {
  return String(q || '').split(/[\s,;/+|]+/).map(normaliseText).filter(Boolean);
}

/**
 * Everything a card can be found by, normalised and joined with a separator a token can
 * never contain — so a word matches inside one field and never straddles two.
 * @param {object} card a normalised card (playerName, team, season, region, role, championPool)
 */
export function searchIndex(card) {
  const fields = [
    card.playerName, card.team, card.season, card.region, card.role,
    // "faker2016" typed as one word still finds Faker 2016.
    `${card.playerName || ''}${card.season || ''}`,
  ];
  for (const p of card.championPool || []) {
    fields.push(p.champion, p.key, championName(p.key || p.champion));
  }
  if (card.artChampionKey) fields.push(card.artChampionKey, championName(card.artChampionKey));
  return fields.map(normaliseText).filter(Boolean).join('|');
}

/**
 * Does this card match every word? A cache keyed by card avoids rebuilding the index on
 * every keystroke; pass the same WeakMap each time.
 * @param {object} card
 * @param {string[]} tokens from queryTokens()
 * @param {WeakMap<object,string>} [cache]
 */
export function cardMatches(card, tokens, cache) {
  if (!tokens.length) return true;
  let hay = cache?.get(card);
  if (hay === undefined) {
    hay = searchIndex(card);
    cache?.set(card, hay);
  }
  return tokens.every((t) => hay.includes(t));
}

/** The sort orders the collection offers, in the order the control lists them. */
export const SORTS = [
  { id: 'rating', label: 'Rating', note: 'highest rating first' },
  { id: 'newest', label: 'Newest', note: 'newest first' },
  { id: 'level', label: 'Level', note: 'highest level first' },
  { id: 'rarity', label: 'Rarity', note: 'rarest first' },
  { id: 'name', label: 'Name', note: 'A to Z' },
];

const byRating = (a, b) => (b.card.ovr ?? 0) - (a.card.ovr ?? 0);
const byName = (a, b) => String(a.card.playerName || '').localeCompare(String(b.card.playerName || ''), 'en', { sensitivity: 'base' })
  || (Number(b.card.season) || 0) - (Number(a.card.season) || 0);
const time = (v) => (v ? new Date(v).getTime() || 0 : 0);

/**
 * Sort collection entries ({ card, level, xp, acquiredAt }) without mutating the input.
 * Every order breaks ties the same way — rating, then name — so the grid never reshuffles
 * between two cards that compare equal.
 * @param {object[]} items
 * @param {string} sort one of SORTS[].id
 */
export function sortCards(items, sort) {
  const list = items.slice();
  const tie = (a, b) => byRating(a, b) || byName(a, b);
  switch (sort) {
    case 'newest':
      return list.sort((a, b) => time(b.acquiredAt) - time(a.acquiredAt) || tie(a, b));
    case 'level':
      return list.sort((a, b) => (b.level ?? 1) - (a.level ?? 1) || (b.xp ?? 0) - (a.xp ?? 0) || tie(a, b));
    case 'rarity':
      return list.sort((a, b) => bandRank(b.card.rarity) - bandRank(a.card.rarity) || tie(a, b));
    case 'name':
      return list.sort((a, b) => byName(a, b) || byRating(a, b));
    default:
      return list.sort(tie);
  }
}

/**
 * The catalogue as sets: one per real team and season ("T1 2023"), which is the unit a
 * collector actually chases and the one roster chemistry rewards.
 *
 * @param {object[]} catalogue normalised cards (cardKey, team, season, region, role, ovr, rarity)
 * @param {Set<string>} ownedKeys card keys the manager holds
 * @returns {{key:string, team:string, season:number|string, region:string, cards:object[], owned:number, total:number}[]}
 *   cards in role order; sets with progress first, then newest season, then team name
 */
export function groupSets(catalogue, ownedKeys) {
  const ROLE_ORDER = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];
  const sets = new Map();
  for (const card of catalogue) {
    if (!card.team) continue;
    const key = `${card.team}|${card.season ?? ''}`;
    let set = sets.get(key);
    if (!set) {
      set = { key, team: card.team, season: card.season ?? '', region: card.region || '', cards: [], owned: 0, total: 0 };
      sets.set(key, set);
    }
    set.cards.push(card);
    set.total += 1;
    if (ownedKeys.has(card.cardKey)) set.owned += 1;
  }
  for (const set of sets.values()) {
    set.cards.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || (b.ovr ?? 0) - (a.ovr ?? 0));
  }
  return [...sets.values()].sort((a, b) => (b.owned > 0) - (a.owned > 0)
    || (b.owned / b.total) - (a.owned / a.total)
    || (Number(b.season) || 0) - (Number(a.season) || 0)
    || a.team.localeCompare(b.team));
}

// --- filters, as a URL can carry them ----------------------------------------

/**
 * The filter state of a collection screen. Everything is a string or null, because it
 * round-trips through the URL query: that is what lets the back button from a card page
 * land on the same filtered, sorted list instead of the top of an unfiltered one.
 */
export const FILTER_DEFAULTS = {
  q: '', role: null, rarity: null, league: null, year: null, team: null, fav: null,
  sort: 'rating', view: 'cards',
};

const first = (v) => (Array.isArray(v) ? v[0] : v);

/** @param {Record<string, unknown>} query a route's query object */
export function readFilters(query = {}) {
  const out = { ...FILTER_DEFAULTS };
  for (const key of Object.keys(FILTER_DEFAULTS)) {
    const v = first(query[key]);
    if (v != null && v !== '') out[key] = String(v);
  }
  if (!SORTS.some((s) => s.id === out.sort)) out.sort = FILTER_DEFAULTS.sort;
  if (out.view !== 'sets') out.view = 'cards';
  return out;
}

/** The query that reproduces a state, with every default left out so URLs stay short. */
export function filtersToQuery(state) {
  const out = {};
  for (const [key, def] of Object.entries(FILTER_DEFAULTS)) {
    const v = state[key];
    if (v != null && v !== '' && v !== def) out[key] = String(v);
  }
  return out;
}

/** How many narrowing filters are on, not counting search, sort or view. */
export function activeFilterCount(state) {
  return ['role', 'rarity', 'league', 'year', 'team', 'fav'].filter((k) => state[k]).length;
}

/**
 * Entries ({ card, ... }) that pass every filter and every search word.
 * @param {object[]} items
 * @param {object} state from readFilters()
 * @param {WeakMap<object,string>} [cache] see cardMatches()
 * @param {(item:object)=>boolean} [isFav] for the starred filter
 */
export function applyFilters(items, state, cache, isFav) {
  const tokens = queryTokens(state.q);
  return items.filter((it) => {
    const c = it.card;
    if (state.role && c.role !== state.role) return false;
    if (state.rarity && c.rarity !== state.rarity) return false;
    if (state.league && c.region !== state.league) return false;
    if (state.year && String(c.season) !== String(state.year)) return false;
    if (state.team && c.team !== state.team) return false;
    if (state.fav && !(isFav && isFav(it))) return false;
    return cardMatches(c, tokens, cache);
  });
}

/** The leagues, seasons and teams present in a set of cards, for the filter controls. */
export function filterOptions(cards) {
  const leagues = new Set();
  const years = new Set();
  const teams = new Set();
  for (const c of cards) {
    if (c.region && c.region !== '—') leagues.add(c.region);
    if (c.season && c.season !== '—') years.add(String(c.season));
    if (c.team) teams.add(c.team);
  }
  return {
    leagues: [...leagues].sort(),
    years: [...years].sort((a, b) => Number(b) - Number(a)),
    teams: [...teams].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
  };
}
