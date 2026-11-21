<script setup lang="ts">
import {
  applyFilters, filterOptions, filtersToQuery, groupSets, readFilters, sortCards, SORTS,
  queryTokens, cardMatches,
} from '@lom/card-engine';
import { toCard } from '~~/shared/cardShape';

/**
 * Your cards, and the catalogue they come from.
 *
 * Two views over one screen. Cards is what you own, searched, sorted and filtered. Sets is
 * the catalogue grouped by real team and season — T1 2023, 4 of 5 — with the cards you are
 * missing drawn as outlines, which is what turns a pile of pulls into something to finish.
 * Completion is shown and nothing else: a reward for finishing a set would be an economy
 * change, and this screen does not make those.
 *
 * Filters, sort, search and view live in the URL, and the list and the scroll position are
 * kept for the session, so going into a card and coming back lands where you were.
 */

const supabase = useSupabaseClient();
const route = useRoute();
const router = useRouter();
const managerId = useManagerId();
const { isPinned, toggle: togglePin } = useCompare();

const NuxtLinkTile = resolveComponent('NuxtLink');

const PAGE = 1000;
const STEP = 48;
const SET_STEP = 12;

const SELECT = `
  id, level, xp, copies, acquired_at,
  card:card_definitions (
    card_key, player_name, season, team, region, role, ovr, rarity,
    sub_stats, art_champion_key, art_focus,
    pool:card_champion_pool ( champion_key, champion_name, games, winrate, mastery, slot )
  )
`;
const CATALOGUE_SELECT = 'card_key, player_name, season, team, region, role, ovr, rarity, art_champion_key, art_focus';

// --- state kept for the session -----------------------------------------------

/** Your rows, kept across navigation so coming back from a card is instant. */
const rows = useState<any[] | null>('cards:rows', () => null);
const favourites = useState<string[]>('cards:favs', () => []);
const inRoster = useState<Record<string, string>>('cards:roster', () => ({}));
/** The active catalogue, for completion and sets. Read once per session. */
const catalogue = useState<any[] | null>('cards:catalogue', () => null);
const scrollMemo = useState<{ path: string; y: number; shown: number; sets: number } | null>('cards:scroll', () => null);

// The cache belongs to whoever filled it: a different sign-in starts from nothing.
const rowsOwner = useState<string | null>('cards:owner', () => null);
if (rowsOwner.value && rowsOwner.value !== managerId.value) {
  rows.value = null;
  favourites.value = [];
  inRoster.value = {};
}

const loading = ref(rows.value === null);
const error = ref('');
const catalogueError = ref('');

async function readPaged(build: (from: number, to: number) => any) {
  const out: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error: err } = await build(from, from + PAGE - 1);
    if (err) throw err;
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function load() {
  if (!managerId.value) return;
  error.value = '';
  try {
    const [list, slots, favs] = await Promise.all([
      readPaged((from, to) => supabase
        .from('collection_cards')
        .select(SELECT)
        .eq('profile_id', managerId.value!)
        .order('acquired_at', { ascending: false })
        .order('id')
        .range(from, to)),
      // roster_slots is readable by its owner; the roster route exists for the writes.
      supabase.from('roster_slots').select('role, collection_card_id').eq('profile_id', managerId.value!),
      // Stars arrive with migration 0017. Before it runs this errors, and the screen
      // simply has no stars rather than no cards.
      supabase.from('collection_cards').select('id').eq('profile_id', managerId.value!).eq('is_favourite', true),
    ]);
    rows.value = list.filter((r: any) => r.card);
    rowsOwner.value = managerId.value;
    const held: Record<string, string> = {};
    for (const slot of (slots.data || []) as any[]) held[slot.collection_card_id] = slot.role;
    inRoster.value = held;
    favourites.value = favs.error ? [] : (favs.data || []).map((r: any) => r.id);
  } catch (e: any) {
    error.value = e?.message || 'Could not load your cards.';
  } finally {
    loading.value = false;
  }
  if (!catalogue.value) loadCatalogue();
}

async function loadCatalogue() {
  catalogueError.value = '';
  try {
    const { data: active, error: err } = await supabase
      .from('catalogue_versions').select('id').eq('is_active', true).maybeSingle();
    if (err) throw err;
    if (!active) { catalogue.value = []; return; }
    const list = await readPaged((from, to) => supabase
      .from('card_definitions')
      .select(CATALOGUE_SELECT)
      .eq('catalogue_version_id', (active as any).id)
      .order('card_key')
      .range(from, to));
    catalogue.value = list.map((r: any) => ({
      cardKey: r.card_key,
      playerName: r.player_name,
      season: r.season ?? undefined,
      team: r.team ?? undefined,
      region: r.region ?? undefined,
      role: r.role ?? 'MID',
      ovr: r.ovr,
      rarity: r.rarity,
      artChampionKey: r.art_champion_key,
      artFocus: r.art_focus,
      subStats: {},
      championPool: [],
    }));
  } catch (e: any) {
    catalogueError.value = e?.message || 'Could not load the catalogue.';
  }
}

watch(managerId, load, { immediate: true });

// --- filters, in the URL ----------------------------------------------------

const filters = computed(() => readFilters(route.query));
function setFilters(next: Record<string, any>) {
  router.replace({ query: filtersToQuery(next) });
}
const setView = (view: string) => setFilters({ ...filters.value, view });

// --- cards ------------------------------------------------------------------

const favSet = computed(() => new Set(favourites.value));

const cards = computed(() => (rows.value || []).map((r: any) => ({
  id: r.id,
  level: r.level,
  xp: r.xp,
  copies: r.copies,
  acquiredAt: r.acquired_at,
  isNew: Date.now() - new Date(r.acquired_at).getTime() < 36 * 3600 * 1000,
  card: toCard(r.card),
})));

const searchCache = new WeakMap<object, string>();
const filtered = computed(() => sortCards(
  applyFilters(cards.value, filters.value, searchCache, (it: any) => favSet.value.has(it.id)),
  filters.value.sort,
));

const ownedKeys = computed(() => new Set(cards.value.map((c) => c.card.cardKey)));

/** Owned and total per rarity: the rarity strip doubles as completion. */
const bands = computed(() => {
  const out: Record<string, { owned: number; total: number | null }> = {};
  for (const b of ['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON']) out[b] = { owned: 0, total: catalogue.value ? 0 : null };
  if (catalogue.value?.length) {
    for (const c of catalogue.value) {
      const n = out[c.rarity];
      if (!n) continue;
      n.total = (n.total || 0) + 1;
      if (ownedKeys.value.has(c.cardKey)) n.owned += 1;
    }
  } else {
    const seen = new Set<string>();
    for (const c of cards.value) {
      if (seen.has(c.card.cardKey)) continue;
      seen.add(c.card.cardKey);
      const n = out[c.card.rarity];
      if (n) n.owned += 1;
    }
  }
  return out;
});

const completion = computed(() => {
  if (!catalogue.value?.length) return null;
  const owned = catalogue.value.filter((c) => ownedKeys.value.has(c.cardKey)).length;
  return { owned, total: catalogue.value.length, pct: Math.floor((owned / catalogue.value.length) * 100) };
});

const options = computed(() => filterOptions(
  filters.value.view === 'sets' && catalogue.value?.length ? catalogue.value : cards.value.map((c) => c.card),
));

// --- sets -------------------------------------------------------------------

/** The best copy you hold of each card key, for the owned slots of a set. */
const ownedByKey = computed(() => {
  const m = new Map<string, any>();
  for (const c of cards.value) {
    const prev = m.get(c.card.cardKey);
    if (!prev || c.level > prev.level) m.set(c.card.cardKey, c);
  }
  return m;
});

const sets = computed(() => {
  const f = filters.value;
  const tokens = queryTokens(f.q);
  const pool = (catalogue.value || []).filter((c) => (!f.league || c.region === f.league)
    && (!f.year || String(c.season) === f.year)
    && (!f.team || c.team === f.team));
  const all = groupSets(pool, ownedKeys.value);
  if (!tokens.length) return all;
  // A set matches a search when its name does or any card in it does.
  return all.filter((s) => cardMatches({ playerName: '', team: s.team, season: s.season, region: s.region }, tokens)
    || s.cards.some((c) => cardMatches(ownedByKey.value.get(c.cardKey)?.card || c, tokens, searchCache)));
});

// --- incremental rendering --------------------------------------------------

const shown = ref(STEP);
const setsShown = ref(SET_STEP);
const visible = computed(() => filtered.value.slice(0, shown.value));
const visibleSets = computed(() => sets.value.slice(0, setsShown.value));
const more = computed(() => (filters.value.view === 'sets'
  ? setsShown.value < sets.value.length
  : shown.value < filtered.value.length));

let restoring = false;
watch(() => JSON.stringify(filters.value), () => {
  if (restoring) return;
  shown.value = STEP;
  setsShown.value = SET_STEP;
});

const sentinel = ref<HTMLElement | null>(null);
let io: IntersectionObserver | null = null;
function showMore() {
  if (filters.value.view === 'sets') setsShown.value += SET_STEP;
  else shown.value += STEP;
}
watch(sentinel, (el, old) => {
  if (old) io?.unobserve(old);
  if (el) io?.observe(el);
});

// --- scroll: put it back where it was --------------------------------------

async function restoreScroll() {
  const memo = scrollMemo.value;
  if (!memo || memo.path !== route.fullPath) return;
  restoring = true;
  shown.value = Math.max(STEP, memo.shown);
  setsShown.value = Math.max(SET_STEP, memo.sets);
  await nextTick();
  requestAnimationFrame(() => {
    window.scrollTo(0, memo.y);
    restoring = false;
    scrollMemo.value = null;
  });
}

onMounted(() => {
  io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) showMore();
  }, { rootMargin: '600px 0px' });
  if (sentinel.value) io.observe(sentinel.value);
  if (!loading.value) restoreScroll();
});
watch(loading, (now) => { if (!now) restoreScroll(); });
onBeforeUnmount(() => io?.disconnect());

// Only a trip into a card is a round trip worth remembering; arriving from a tab starts at the top.
onBeforeRouteLeave((to) => {
  if (!to.path.startsWith('/card/')) { scrollMemo.value = null; return; }
  scrollMemo.value = { path: route.fullPath, y: window.scrollY, shown: shown.value, sets: setsShown.value };
});

// --- compare ----------------------------------------------------------------

const picking = ref(false);
const pinId = (item: any) => `mine:${item.id}`;
function pick(item: any) {
  togglePin({ id: pinId(item), owner: null, level: item.level, card: item.card });
}

function clearFilters() {
  setFilters({ ...filters.value, q: '', role: null, rarity: null, league: null, year: null, team: null, fav: null });
}

const sortNote = computed(() => SORTS.find((s) => s.id === filters.value.sort)?.note || '');

useHead({ title: 'Cards — LOM' });
</script>


<template>
  <main class="page page--full cards">
    <header class="topbar">
      <h1>Cards</h1>
      <div v-if="cards.length" class="seg cards__view" role="group" aria-label="View">
        <button type="button" :aria-pressed="filters.view === 'cards'" @click="setView('cards')">Yours</button>
        <button type="button" :aria-pressed="filters.view === 'sets'" @click="setView('sets')">Sets</button>
      </div>
    </header>

    <p v-if="error" class="notice notice--bad" role="alert">
      {{ error }} <button class="linkish" type="button" @click="load">Retry</button>
    </p>

    <p v-if="cards.length" class="cards__done">
      <template v-if="completion">
        <b class="tnum">{{ completion.owned }}</b><span class="faint"> / {{ completion.total }} collected</span>
        <span class="cards__bar" aria-hidden="true"><i :style="{ width: `${Math.max(1, completion.pct)}%` }" /></span>
      </template>
      <template v-else>
        <b class="tnum">{{ cards.length }}</b><span class="faint"> {{ cards.length === 1 ? 'card' : 'cards' }}</span>
        <span v-if="catalogueError" class="faint"> · completion unavailable</span>
      </template>
    </p>

    <CardFilters
      v-if="cards.length"
      :model-value="filters"
      :options="options"
      :bands="bands"
      :result-count="filters.view === 'sets' ? sets.length : filtered.length"
      :hide="filters.view === 'sets' ? ['role', 'rarity', 'fav'] : []"
      :show-fav="favourites.length > 0"
      @update:model-value="setFilters"
    >
      <template #actions>
        <button
          v-if="filters.view === 'cards'"
          class="chip cards__pick" type="button" :aria-pressed="picking" data-sound="toggle"
          @click="picking = !picking"
        >
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4v16M19 4v16M9 8h6M9 12h6M9 16h6" /></svg>
          {{ picking ? 'Picking to compare' : 'Compare' }}
        </button>
      </template>
    </CardFilters>

    <p v-if="picking && filters.view === 'cards'" class="cards__hint faint">Tap up to two cards to pin them. Tap Compare again to go back to opening cards.</p>

    <div v-if="loading" class="card-grid">
      <div v-for="i in 9" :key="i" class="skeleton grid-skeleton" />
    </div>

    <div v-else-if="!cards.length && !error" class="empty">
      <h2>Nothing yet</h2>
      <p>Open today's pack and your first card lands here.</p>
      <NuxtLink class="btn" to="/pack">Go to the pack</NuxtLink>
    </div>

    <!-- yours -------------------------------------------------------------- -->
    <template v-else-if="filters.view === 'cards'">
      <div v-if="!filtered.length" class="empty">
        <h2>No match</h2>
        <p>Nothing in your collection fits that search and those filters.</p>
        <button class="btn btn--ghost" type="button" @click="clearFilters">Clear filters</button>
      </div>

      <template v-else>
        <p class="cards__count faint">{{ filtered.length }} shown · {{ sortNote }}</p>
        <div class="card-grid">
          <component
            :is="picking ? 'button' : NuxtLinkTile"
            v-for="item in visible" :key="item.id"
            class="card-grid__item cards__tile"
            :class="{ 'is-pinned': isPinned(pinId(item)) }"
            v-bind="picking
              ? { type: 'button', 'aria-pressed': isPinned(pinId(item)), onClick: () => pick(item) }
              : { to: `/card/${item.card.cardKey}` }"
          >
            <span class="card-grid__tags">
              <span v-if="picking && isPinned(pinId(item))" class="card-grid__badge card-grid__badge--new">Pinned</span>
              <span v-else-if="item.isNew" class="card-grid__badge card-grid__badge--new">New</span>
              <span v-else-if="item.level > 1" class="card-grid__badge">Lv {{ item.level }}</span>
              <span v-if="inRoster[item.id]" class="card-grid__slot" :title="'In your five at ' + inRoster[item.id]">{{ inRoster[item.id] }}</span>
              <span v-if="favSet.has(item.id)" class="card-grid__star" title="Starred">★<span class="sr-only">Starred</span></span>
              <span v-if="item.copies > 1" class="card-grid__dupes" :title="`Pulled ${item.copies} times`">×{{ item.copies }}</span>
            </span>
            <LomCard :card="item.card" compact :interactive="false" />
          </component>
        </div>
      </template>
    </template>

    <!-- sets --------------------------------------------------------------- -->
    <template v-else>
      <div v-if="catalogue === null && !catalogueError" class="card-grid">
        <div v-for="i in 5" :key="i" class="skeleton grid-skeleton" />
      </div>
      <div v-else-if="catalogueError" class="empty">
        <h2>Sets did not load</h2>
        <p>{{ catalogueError }}</p>
        <button class="btn btn--ghost" type="button" @click="loadCatalogue">Retry</button>
      </div>
      <div v-else-if="!sets.length" class="empty">
        <h2>No match</h2>
        <p>No team and season fits that search and those filters.</p>
        <button class="btn btn--ghost" type="button" @click="clearFilters">Clear filters</button>
      </div>
      <template v-else>
        <p class="cards__count faint">
          {{ sets.length }} sets · a set is one team's players from one season · display only, no reward
        </p>
        <section v-for="s in visibleSets" :key="s.key" class="set" :aria-label="`${s.team} ${s.season}`">
          <header class="set__head">
            <h2 class="set__name">{{ s.team }} <span>{{ s.season }}</span></h2>
            <span class="set__meta faint">{{ s.region }}</span>
            <span class="set__count tnum" :class="{ 'is-done': s.owned === s.total }">
              {{ s.owned }}/{{ s.total }}<template v-if="s.owned === s.total"> · complete</template>
            </span>
          </header>
          <div class="set__cards">
            <template v-for="c in s.cards" :key="c.cardKey">
              <NuxtLink v-if="ownedByKey.get(c.cardKey)" class="set__card" :to="`/card/${c.cardKey}`">
                <LomCard :card="ownedByKey.get(c.cardKey).card" compact :interactive="false" />
              </NuxtLink>
              <div v-else class="set__card set__ghost" :class="`is-${String(c.rarity).toLowerCase()}`" :aria-label="`Missing: ${c.playerName} ${c.season}, ${c.role}`">
                <i class="gem" :class="`gem--${String(c.rarity).toLowerCase()}`" aria-hidden="true" />
                <span class="set__ovr tnum">{{ c.ovr }}</span>
                <span class="set__who">{{ c.playerName }}</span>
                <span class="set__role">{{ c.role }}</span>
              </div>
            </template>
          </div>
        </section>
      </template>
    </template>

    <div v-if="!loading && more" ref="sentinel" class="cards__more">
      <button class="btn btn--quiet" type="button" @click="showMore">Show more</button>
    </div>

    <CompareTray />
  </main>
</template>

<style scoped>
.cards__view { flex: none; }
.cards__view button { padding: 0 14px; }

.cards__done { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px; margin: -4px 0 12px; font-size: 13.5px; }
.cards__done b { font-stretch: 80%; font-weight: 820; font-size: 20px; }
.cards__bar { flex: 1 0 100%; height: 3px; margin-top: 6px; background: var(--bg-3); border-radius: 2px; overflow: hidden; }
.cards__bar i { display: block; height: 100%; background: var(--gold-2); }

.cards__pick svg { width: 17px; height: 17px; }
.cards__hint { margin: -4px 0 12px; font-size: 12.5px; }
.cards__count { margin: 0 0 12px; font-size: 12.5px; }
.grid-skeleton { aspect-ratio: 63 / 88; }
.card-grid__badge--new { --tag: var(--gold-2); color: var(--gold-ink) !important; }
.card-grid__star { position: relative; display: inline-flex; align-items: center; height: 20px; padding: 0 2px; font-size: 13px; color: var(--gold-1); }

/* Each tile is skipped by layout and paint until it is near the viewport. */
.cards__tile { content-visibility: auto; contain-intrinsic-size: auto 200px; }
button.cards__tile { appearance: none; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.cards__tile.is-pinned :deep(.lom-card) { outline: 2px solid var(--gold-2); outline-offset: 3px; }

.cards__more { display: flex; justify-content: center; padding: 24px 0; }
.linkish { appearance: none; padding: 0; border: 0; background: none; color: var(--ink-1); font: inherit; font-weight: 700; text-decoration: underline; cursor: pointer; }

.set { padding: 14px 0 18px; border-top: 1px solid var(--line-1); content-visibility: auto; contain-intrinsic-size: auto 260px; }
.set__head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.set__name { margin: 0; font-stretch: 85%; font-weight: 800; font-size: 19px; }
.set__name span { color: var(--gold-1); }
.set__meta { font-size: 12.5px; }
.set__count { margin-left: auto; font-weight: 760; font-size: 14px; }
.set__count.is-done { color: var(--gold-1); }
.set__cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px; }
@media (min-width: 1024px) { .set__cards { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 14px; } }
.set__card { display: block; min-width: 0; }

/* A missing card: an outline in its rarity, with the gem shape so it reads without colour. */
.set__ghost {
  --rc: var(--r-common);
  aspect-ratio: 63 / 88;
  display: grid;
  grid-template-rows: auto 1fr auto auto;
  justify-items: center;
  align-items: end;
  gap: 2px;
  padding: 10px 6px;
  border: 1px dashed color-mix(in srgb, var(--rc) 55%, transparent);
  border-radius: 4.6% / 3.3%;
  background: rgba(12, 18, 30, 0.5);
  color: var(--ink-3);
  text-align: center;
}
.set__ghost.is-rare { --rc: var(--r-rare); }
.set__ghost.is-epic { --rc: var(--r-epic); }
.set__ghost.is-legendary { --rc: var(--r-legendary); }
.set__ghost.is-icon { --rc: var(--r-icon); }
.set__ghost .gem { align-self: start; justify-self: end; opacity: 0.7; }
.set__ovr { font-stretch: 75%; font-weight: 840; font-size: 24px; color: var(--ink-3); align-self: center; }
.set__who { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; font-size: 13px; color: var(--ink-2); }
.set__role { font-stretch: 112%; font-size: 10px; font-weight: 760; letter-spacing: 0.12em; }
</style>
