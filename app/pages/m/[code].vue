<script setup lang="ts">
import { formatShareCode } from '~~/shared/shareCode';

/**
 * Another manager's collection, reached by their share code.
 *
 * Deliberately not /collection with a parameter: this view reads through a server
 * route holding the service-role key, because RLS hides every row that is not yours
 * and the code is the only thing that authorises the read. Keeping it on its own
 * route keeps that difference visible — /collection is yours and talks to Postgres
 * directly, /m/:code is someone else's and never does.
 *
 * Tiles are not links. A card detail page reads the signed-in manager's collection,
 * so tapping through would land on "you do not have this card", which is true and
 * useless. Cards here are interactive instead: a tap flips one, which is the thing
 * you came to do.
 */

const route = useRoute();
const code = computed(() => String(route.params.code || ''));

const ROLES = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];
const BANDS = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON'];

const data = ref<any>(null);
const loading = ref(true);
const error = ref('');

const role = ref<string | null>(null);
const band = ref<string | null>(null);
const search = ref('');

async function load() {
  loading.value = true;
  try {
    data.value = await $fetch<any>('/api/discovery/collection', { query: { code: code.value } });
    error.value = '';
  } catch (e: any) {
    error.value = e?.statusMessage || e?.data?.statusMessage || 'Could not open that collection.';
  } finally {
    loading.value = false;
  }
}

watch(code, load, { immediate: true });

const cards = computed<any[]>(() => data.value?.cards ?? []);

const byBand = computed(() => {
  const counts: Record<string, number> = {};
  for (const c of cards.value) counts[c.card.rarity] = (counts[c.card.rarity] || 0) + 1;
  return counts;
});

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return cards.value
    .filter((c) => !role.value || c.card.role === role.value)
    .filter((c) => !band.value || c.card.rarity === band.value)
    .filter((c) => {
      if (!q) return true;
      const hay = `${c.card.playerName} ${c.card.team} ${c.card.season} `
        + c.card.championPool.map((p: any) => p.champion).join(' ');
      return hay.toLowerCase().includes(q);
    })
    .sort((a, b) => b.card.ovr - a.card.ovr);
});

const BAND_LABEL: Record<string, string> = { COMMON: 'Common', RARE: 'Rare', EPIC: 'Epic', LEGENDARY: 'Legendary', ICON: 'Icon' };
// Rarest first, as on your own Cards screen.
const BANDS_DESC = [...BANDS].reverse();

function clearFilters() {
  role.value = null;
  band.value = null;
  search.value = '';
}

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

    <p v-if="error" class="notice notice--bad" role="alert">{{ error }}</p>

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
      <p v-if="data.collection.best" class="muted who__best">
        Best: {{ data.collection.best.playerName }}
        <template v-if="data.collection.best.season">{{ data.collection.best.season }}</template>
        · <span class="tnum">{{ data.collection.best.ovr }}</span> OVR
      </p>
    </section>

    <h1 v-else class="sr-only">A manager's cards</h1>

    <section v-if="loading || data" class="block">
      <h2 class="sect">Cards</h2>

      <div class="cards__layout">
        <aside v-if="cards.length" class="filters">
          <input
            v-model="search" class="input filters__search" type="search"
            placeholder="Player, team or champion" aria-label="Search these cards"
          >
          <div class="seg filters__roles" role="group" aria-label="Role">
            <button type="button" :aria-pressed="role === null" @click="role = null">All</button>
            <button
              v-for="r in ROLES" :key="r" type="button"
              :aria-pressed="role === r" @click="role = role === r ? null : r"
            >{{ r }}</button>
          </div>
          <div class="filters__bands" role="group" aria-label="Rarity">
            <button
              v-for="b in BANDS_DESC" :key="b" class="chip" type="button"
              :aria-pressed="band === b" :disabled="!byBand[b]"
              @click="band = band === b ? null : b"
            >
              <i class="gem" :class="`gem--${b.toLowerCase()}`" aria-hidden="true" />
              {{ BAND_LABEL[b] }}<span class="chip__n">{{ byBand[b] || 0 }}</span>
            </button>
          </div>
        </aside>

        <div class="cards__main">
          <p v-if="cards.length" class="cards__count faint">
            {{ filtered.length }} shown · highest rating first
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
            <p>None of these cards fit those filters.</p>
            <button class="btn btn--ghost" type="button" @click="clearFilters">Clear filters</button>
          </div>

          <div v-else-if="data" class="card-grid">
            <div v-for="item in filtered" :key="item.id" class="card-grid__item">
              <LomCard :card="item.card" compact />
              <span v-if="item.level > 1" class="card-grid__badge">Lv {{ item.level }}</span>
              <span v-if="item.copies > 1" class="card-grid__dupes">×{{ item.copies }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <p v-if="data && !data.isSelf" class="faint foot">
      Found by code, so they stay on your list. <NuxtLink to="/discovery">See everyone you have found</NuxtLink>.
    </p>
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
.sect { margin: 0 0 12px; font-stretch: 92%; font-weight: 720; font-size: 17px; }

.filters { display: grid; gap: 10px; margin-bottom: 16px; }
.filters__search { min-height: 44px; font-size: 16px; }
.filters__roles button { font-size: 11px; }
.filters__bands { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; margin-right: -16px; padding-right: 16px; }
.filters__bands::-webkit-scrollbar { display: none; }
.cards__count { margin: 0 0 12px; font-size: 12.5px; }
.grid-skeleton { aspect-ratio: 63 / 88; }

.foot { font-size: 12.5px; margin: 24px 0 0; text-align: center; }

@media (min-width: 1024px) {
  .cards__layout { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 36px; align-items: start; }
  .cards__layout:not(:has(.filters)) { grid-template-columns: minmax(0, 1fr); }
  .filters { position: sticky; top: calc(var(--appbar-h) + 16px); }
  .filters__roles { flex-direction: column; }
  .filters__roles button { justify-content: flex-start; padding: 0 12px; }
  .filters__bands { flex-direction: column; margin: 0; padding: 0; overflow: visible; }
  .filters__bands .chip { justify-content: flex-start; }
  .filters__bands .chip__n { margin-left: auto; }
}
</style>
