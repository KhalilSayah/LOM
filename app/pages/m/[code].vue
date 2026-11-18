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

useHead(() => ({
  title: data.value
    ? `${data.value.manager.displayName}'s collection — LOM`
    : 'Collection — LOM',
}));
</script>

<template>
  <main class="page page--wide">
    <header class="topbar">
      <button class="btn btn--quiet" type="button" @click="$router.back()">Back</button>
      <span v-if="data" class="topbar__meta">{{ formatShareCode(data.manager.shareCode) }}</span>
    </header>

    <p v-if="error" class="notice notice--bad">{{ error }}</p>

    <template v-if="data">
      <section class="panel who">
        <p class="eyebrow">{{ data.isSelf ? 'You' : 'Manager' }}</p>
        <p class="who__name">{{ data.manager.displayName }}</p>
        <p class="muted who__handle">@{{ data.manager.handle }}</p>
        <p class="who__total">
          <span class="tnum who__n">{{ data.collection.total }}</span>
          <span class="who__unit">{{ data.collection.total === 1 ? 'card' : 'cards' }}</span>
        </p>
        <p v-if="data.collection.best" class="muted who__best">
          Best: {{ data.collection.best.playerName }}
          <template v-if="data.collection.best.season">{{ data.collection.best.season }}</template>
          · {{ data.collection.best.ovr }} OVR
        </p>
      </section>

      <div v-if="cards.length" class="filters">
        <input
          v-model="search" class="filters__search" type="search"
          placeholder="Player, team or champion" aria-label="Search this collection"
        >
        <div class="chips">
          <button class="chip" :aria-pressed="role === null" @click="role = null">All</button>
          <button
            v-for="r in ROLES" :key="r" class="chip"
            :aria-pressed="role === r" @click="role = role === r ? null : r"
          >{{ r }}</button>
        </div>
        <div class="chips">
          <button
            v-for="b in BANDS" :key="b" class="chip"
            :aria-pressed="band === b" :disabled="!byBand[b]"
            @click="band = band === b ? null : b"
          >
            {{ b.toLowerCase() }}<span v-if="byBand[b]" class="chip__n"> {{ byBand[b] }}</span>
          </button>
        </div>
      </div>
    </template>

    <div v-if="loading" class="card-grid">
      <div v-for="i in 6" :key="i" class="skeleton grid-skeleton" />
    </div>

    <div v-else-if="data && !cards.length" class="empty">
      <h2>Nothing here yet</h2>
      <p>{{ data.manager.displayName }} has not opened a pack.</p>
    </div>

    <div v-else-if="data && !filtered.length" class="empty">
      <h2>No match</h2>
      <p>Nothing in this collection fits those filters.</p>
    </div>

    <div v-else-if="data" class="card-grid">
      <div v-for="item in filtered" :key="item.id" class="card-grid__item">
        <span v-if="item.level > 1" class="card-grid__badge">LV {{ item.level }}</span>
        <span v-if="item.copies > 1" class="card-grid__dupes">×{{ item.copies }}</span>
        <LomCard :card="item.card" compact />
      </div>
    </div>

    <p v-if="data && !data.isSelf" class="faint foot">
      Found by code. They stay in your Discovery list — <NuxtLink to="/discovery">see everyone</NuxtLink>.
    </p>
  </main>
</template>

<style scoped>
.who__name { font-family: var(--font-display); font-size: 24px; font-weight: 700; margin: 6px 0 0; }
.who__handle { font-size: 13.5px; margin: 2px 0 0; }
.who__total { display: flex; align-items: baseline; gap: 7px; margin: 12px 0 0; }
.who__n { font-family: var(--font-display); font-size: 30px; font-weight: 700; }
.who__unit {
  font-family: var(--font-label);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink-dim);
}
.who__best { font-size: 13.5px; margin: 8px 0 0; }

.filters { display: grid; gap: 8px; margin: 14px 0 16px; }
.filters__search {
  width: 100%;
  min-height: 44px;
  padding: 0 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--sunken);
  color: var(--ink);
  font-family: inherit;
  font-size: 16px;
}
.filters__search:focus { border-color: var(--accent); outline: none; }
.chip:disabled { opacity: 0.35; cursor: default; }
.chip__n { opacity: 0.7; margin-left: 2px; }
.grid-skeleton { aspect-ratio: 63 / 88; }
.foot { font-size: 12.5px; margin: 18px 0 0; text-align: center; }
.foot a { color: var(--accent); }
</style>
