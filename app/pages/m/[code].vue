<script setup lang="ts">
import { formatShareCode } from '~~/shared/shareCode';
import { applyFilters, filterOptions, filtersToQuery, readFilters, sortCards, SORTS } from '@lom/card-engine';

/**
 * Another manager's collection, reached by their share code.
 *
 * Deliberately not /collection with a parameter: this view reads through a server
 * route holding the service-role key, because RLS hides every row that is not yours
 * and the code is the only thing that authorises the read. Keeping it on its own
 * route keeps that difference visible — /collection is yours and talks to Postgres
 * directly, /m/:code is someone else's and never does.
 *
 * The cards they starred lead the page: that is them choosing what to show you. A tile
 * opens the card read-only (/card/<key>?from=<code>), where you can pin it and compare it
 * against one of yours. Search, sort and filters work as they do on your own Cards and
 * live in the URL, so the back button from a card lands on the same list.
 */

const route = useRoute();
const router = useRouter();
const code = computed(() => String(route.params.code || ''));
const { isPinned, toggle: togglePin } = useCompare();
const NuxtLinkTile = resolveComponent('NuxtLink');

const STEP = 48;

/** Kept for the session per code, so coming back from one of their cards is instant. */
const cache = useState<Record<string, any>>('m:cache', () => ({}));
const data = ref<any>(cache.value[code.value] ?? null);
const loading = ref(!data.value);
const error = ref('');

async function load() {
  if (!data.value) loading.value = true;
  try {
    const res = await $fetch<any>('/api/discovery/collection', { query: { code: code.value } });
    data.value = res;
    cache.value = { ...cache.value, [code.value]: res };
    error.value = '';
  } catch (e: any) {
    error.value = e?.statusMessage || e?.data?.statusMessage || 'Could not open that collection.';
  } finally {
    loading.value = false;
  }
}

watch(code, (c) => {
  data.value = cache.value[c] ?? null;
  load();
}, { immediate: true });

const cards = computed<any[]>(() => data.value?.cards ?? []);

const filters = computed(() => {
  const f = readFilters(route.query);
  return { ...f, view: 'cards' };
});
const setFilters = (next: Record<string, any>) => router.replace({ query: filtersToQuery({ ...next, view: 'cards' }) });

const searchCache = new WeakMap<object, string>();
const filtered = computed(() => sortCards(applyFilters(cards.value, filters.value, searchCache), filters.value.sort));
const options = computed(() => filterOptions(cards.value.map((c) => c.card)));

const bands = computed(() => {
  const out: Record<string, { owned: number; total: number | null }> = {};
  for (const b of ['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON']) out[b] = { owned: 0, total: null };
  for (const c of cards.value) { const n = out[c.card.rarity]; if (n) n.owned += 1; }
  return out;
});

/** Their starred cards, as full entries from the list so they render as cards. */
const showcase = computed(() => {
  const ids: string[] = (data.value?.collection?.showcase || []).map((s: any) => s.id);
  const byId = new Map(cards.value.map((c) => [c.id, c]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
});

// --- incremental rendering --------------------------------------------------

const shown = ref(STEP);
const visible = computed(() => filtered.value.slice(0, shown.value));
watch(() => JSON.stringify(filters.value), () => { shown.value = STEP; });

const sentinel = ref<HTMLElement | null>(null);
let io: IntersectionObserver | null = null;
onMounted(() => {
  io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) shown.value += STEP;
  }, { rootMargin: '600px 0px' });
  if (sentinel.value) io.observe(sentinel.value);
});
watch(sentinel, (el, old) => {
  if (old) io?.unobserve(old);
  if (el) io?.observe(el);
});
onBeforeUnmount(() => io?.disconnect());

// --- compare ----------------------------------------------------------------

const picking = ref(false);
const pinId = (item: any) => `${code.value}:${item.id}`;
function pick(item: any) {
  togglePin({ id: pinId(item), owner: data.value?.manager?.displayName ?? null, level: item.level, card: item.card });
}
const cardLink = (item: any) => `/card/${item.card.cardKey}?from=${code.value}`;

function clearFilters() {
  setFilters({ ...filters.value, q: '', role: null, rarity: null, league: null, year: null, team: null, fav: null });
}

const sortNote = computed(() => SORTS.find((s) => s.id === filters.value.sort)?.note || '');

useHead(() => ({
  title: data.value
    ? `${data.value.manager.displayName}'s cards — LOM`
    : 'Cards — LOM',
}));
</script>

<template>
  <main class="page page--wide">
    <header class="topbar">
      <NuxtLink class="backlink" to="/discovery"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>Find a manager</NuxtLink>
      <span v-if="data" class="topbar__meta tnum">{{ formatShareCode(data.manager.shareCode) }}</span>
    </header>

    <p v-if="error" class="notice notice--bad" role="alert">
      {{ error }} <button class="linkish" type="button" @click="load">Retry</button>
    </p>

    <div v-if="loading" class="skeleton head-skeleton" />

    <section v-else-if="data" class="who">
      <h1 class="who__name">
        {{ data.manager.displayName }}
        <span v-if="data.isSelf" class="tag">You</span>
      </h1>
      <p class="muted who__handle">@{{ data.manager.handle }}</p>
      <p class="who__total">
        <span class="num who__n">{{ data.collection.total }}</span>
        <span class="who__unit">{{ data.collection.total === 1 ? 'card' : 'cards' }}</span>
      </p>
      <p v-if="!showcase.length && data.collection.best" class="muted who__best">
        Best: {{ data.collection.best.playerName }}
        <template v-if="data.collection.best.season">{{ data.collection.best.season }}</template>
        · <span class="tnum">{{ data.collection.best.ovr }}</span> OVR
      </p>
    </section>

    <h1 v-else class="sr-only">A manager's cards</h1>

    <section v-if="showcase.length" class="block showcase" aria-labelledby="showcase-h">
      <h2 id="showcase-h" class="sect">{{ data.isSelf ? 'Your showcase' : 'Showcase' }}<span class="faint">starred by {{ data.isSelf ? 'you' : data.manager.displayName }}</span></h2>
      <div class="showcase__cards">
        <NuxtLink v-for="item in showcase" :key="item.id" class="showcase__card" :to="cardLink(item)">
          <LomCard :card="item.card" compact :interactive="false" />
        </NuxtLink>
      </div>
    </section>

    <section v-if="loading || data" class="block">
      <h2 class="sect">Cards</h2>

      <CardFilters
        v-if="cards.length"
        :model-value="filters"
        :options="options"
        :bands="bands"
        :result-count="filtered.length"
        @update:model-value="setFilters"
      >
        <template #actions>
          <button class="chip" type="button" :aria-pressed="picking" data-sound="toggle" @click="picking = !picking">
            {{ picking ? 'Picking to compare' : 'Compare' }}
          </button>
        </template>
      </CardFilters>
      <p v-if="picking" class="faint pick-hint">Tap a card of theirs to pin it, then pin one of yours from your Cards or a card page.</p>

      <p v-if="cards.length" class="cards__count faint">
        {{ filtered.length }} shown · {{ sortNote }}
      </p>

      <div v-if="loading" class="card-grid">
        <div v-for="i in 6" :key="i" class="skeleton grid-skeleton" />
      </div>

      <div v-else-if="data && !cards.length" class="empty">
        <h2>Nothing here yet</h2>
        <p>{{ data.manager.displayName }} has not opened a pack.</p>
      </div>

      <div v-else-if="data && !filtered.length" class="empty">
        <h2>No match</h2>
        <p>None of these cards fit that search and those filters.</p>
        <button class="btn btn--ghost" type="button" @click="clearFilters">Clear filters</button>
      </div>

      <div v-else-if="data" class="card-grid">
        <component
          :is="picking ? 'button' : NuxtLinkTile"
          v-for="item in visible" :key="item.id"
          class="card-grid__item tile"
          :class="{ 'is-pinned': isPinned(pinId(item)) }"
          v-bind="picking
            ? { type: 'button', 'aria-pressed': isPinned(pinId(item)), onClick: () => pick(item) }
            : { to: cardLink(item) }"
        >
          <span class="card-grid__tags">
            <span v-if="picking && isPinned(pinId(item))" class="card-grid__badge card-grid__badge--new">Pinned</span>
            <span v-else-if="item.level > 1" class="card-grid__badge">Lv {{ item.level }}</span>
            <span v-if="item.copies > 1" class="card-grid__dupes" :title="`Pulled ${item.copies} times`">×{{ item.copies }}</span>
          </span>
          <LomCard :card="item.card" compact :interactive="false" />
        </component>
      </div>

      <div v-if="!loading && shown < filtered.length" ref="sentinel" class="more">
        <button class="btn btn--quiet" type="button" @click="shown += STEP">Show more</button>
      </div>
    </section>

    <p v-if="data && !data.isSelf" class="faint foot">
      Found by code, so they stay on your list. <NuxtLink to="/discovery">See everyone you have found</NuxtLink>.
    </p>

    <CompareTray />
  </main>
</template>

<style scoped>
.backlink { display: inline-flex; align-items: center; gap: 4px; min-height: 44px; margin-left: -6px; padding-right: 8px; font-size: 13.5px; font-weight: 600; color: var(--ink-2); }
.backlink svg { width: 20px; height: 20px; }
.backlink:hover { color: var(--ink-1); }

.head-skeleton { height: 120px; }

.who__name { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: clamp(30px, 7vw, 44px); line-height: 0.95; margin: 4px 0 0; }
.who__handle { font-size: 13.5px; margin: 6px 0 0; }
.who__total { display: flex; align-items: baseline; gap: 7px; margin: 14px 0 0; }
.who__n { font-size: 30px; }
.who__unit { font-size: 13px; font-weight: 600; color: var(--ink-3); }
.who__best { font-size: 13.5px; margin: 6px 0 0; }

.block { margin-top: 28px; }
.sect { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin: 0 0 12px; font-stretch: 92%; font-weight: 720; font-size: 17px; }
.sect .faint { font-stretch: 100%; font-weight: 500; font-size: 12.5px; }

.showcase__cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; max-width: 520px; }
.showcase__card { display: block; min-width: 0; }

.pick-hint { margin: -4px 0 12px; font-size: 12.5px; }
.cards__count { margin: 0 0 12px; font-size: 12.5px; }
.grid-skeleton { aspect-ratio: 63 / 88; }
.card-grid__badge--new { --tag: var(--gold-2); color: var(--gold-ink) !important; }
.tile { content-visibility: auto; contain-intrinsic-size: auto 200px; }
button.tile { appearance: none; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.tile.is-pinned :deep(.lom-card) { outline: 2px solid var(--gold-2); outline-offset: 3px; }
.more { display: flex; justify-content: center; padding: 24px 0; }
.linkish { appearance: none; padding: 0; border: 0; background: none; color: var(--ink-1); font: inherit; font-weight: 700; text-decoration: underline; cursor: pointer; }

.foot { font-size: 12.5px; margin: 24px 0 0; text-align: center; }
</style>
