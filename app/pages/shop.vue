<script setup lang="ts">
/**
 * The pack shop.
 *
 * Every pack shows what it costs, how many cards it gives and the odds behind each slot,
 * because the argument docs/02 section 5.2 makes about pity — that hiding it is just
 * anxiety — applies at least as much to something you are about to spend Credits on.
 */

interface ShopPack {
  key: string;
  name: string;
  blurb: string | null;
  price: number;
  slots: number;
  one_per_role: boolean;
  weights: Record<string, number>;
  floor_band: string | null;
  max_band: string | null;
  daily_limit: number | null;
  remainingToday: number | null;
  affordable: boolean;
  canBuy: boolean;
}

interface Shop {
  credits: number;
  packs: ShopPack[];
}

useHead({ title: 'Packs — LOM' });

const BANDS = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON'] as const;

const shop = ref<Shop | null>(null);
const loading = ref(true);
const buying = ref<string | null>(null);
const error = ref('');
const opened = ref<null | { packName: string; spent: number; creditsEarned: number; cards: any[] }>(null);

async function load() {
  try {
    shop.value = await $fetch<Shop>('/api/pack/shop');
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'Could not load the shop.';
  } finally {
    loading.value = false;
  }
}

async function buy(pack: ShopPack) {
  if (!pack.canBuy || buying.value) return;
  buying.value = pack.key;
  error.value = '';
  try {
    opened.value = await $fetch('/api/pack/buy', {
      method: 'POST',
      body: { packType: pack.key },
    });
    await load();
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'The pack did not open.';
    await load();
  } finally {
    buying.value = null;
  }
}

/** Odds as whole percentages, so the bar and the label agree. */
function odds(pack: ShopPack) {
  const total = BANDS.reduce((n, b) => n + (pack.weights[b] ?? 0), 0) || 1;
  return BANDS
    .map((b) => ({ band: b, pct: ((pack.weights[b] ?? 0) / total) * 100 }))
    .filter((o) => o.pct > 0);
}

const label = (pack: ShopPack) => {
  if (pack.one_per_role) return `${pack.slots} cards, one per lane`;
  return pack.slots === 1 ? '1 card' : `${pack.slots} cards`;
};

onMounted(load);
</script>

<template>
  <main class="page">
    <header class="topbar">
      <h1>Packs</h1>
      <span class="topbar__meta tnum">{{ shop?.credits ?? 0 }} credits</span>
    </header>

    <p v-if="error" class="notice notice--bad">{{ error }}</p>

    <div v-if="loading" class="skeleton shop-skeleton" />

    <!-- what just came out -->
    <section v-else-if="opened" class="opened">
      <p class="eyebrow">{{ opened.packName }}</p>
      <h2 class="opened__head">
        {{ opened.cards.length }} {{ opened.cards.length === 1 ? 'card' : 'cards' }}
      </h2>
      <div class="opened__grid">
        <article v-for="c in opened.cards" :key="c.slot" class="opened__slot">
          <LomCard v-if="c.card" :card="c.card" />
          <p v-if="c.wasDuplicate" class="faint opened__dupe">
            Duplicate — +{{ c.xpAwarded }} XP<span v-if="c.creditsAwarded">, +{{ c.creditsAwarded }} credits</span>
          </p>
        </article>
      </div>
      <p v-if="opened.creditsEarned" class="notice">
        Duplicates paid back <strong>{{ opened.creditsEarned }} credits</strong>.
      </p>
      <div class="opened__actions">
        <button class="btn btn--ghost" @click="opened = null">Back to packs</button>
        <NuxtLink class="btn" to="/collection">See collection</NuxtLink>
      </div>
    </section>

    <template v-else>
      <section v-for="pack in shop?.packs || []" :key="pack.key" class="panel shop__pack">
        <div class="shop__head">
          <div>
            <h2 class="shop__name">{{ pack.name }}</h2>
            <p class="faint shop__slots">{{ label(pack) }}</p>
          </div>
          <span class="shop__price tnum">{{ pack.price }}</span>
        </div>

        <p v-if="pack.blurb" class="muted shop__blurb">{{ pack.blurb }}</p>

        <div class="shop__odds" aria-hidden="true">
          <span
            v-for="o in odds(pack)"
            :key="o.band"
            class="shop__band"
            :class="`shop__band--${o.band.toLowerCase()}`"
            :style="{ flexGrow: o.pct }"
          />
        </div>
        <ul class="shop__legend">
          <li v-for="o in odds(pack)" :key="o.band">
            <span class="shop__dot" :class="`shop__band--${o.band.toLowerCase()}`" />
            {{ o.band.toLowerCase() }} {{ o.pct.toFixed(o.pct < 1 ? 1 : 0) }}%
          </li>
        </ul>

        <p v-if="pack.floor_band" class="faint shop__note">
          One card is {{ pack.floor_band.toLowerCase() }} at worst.
        </p>
        <p v-else-if="pack.max_band" class="faint shop__note">
          Nothing above {{ pack.max_band.toLowerCase() }} can appear.
        </p>

        <button
          class="btn btn--block"
          :disabled="!pack.canBuy || buying !== null"
          @click="buy(pack)"
        >
          <template v-if="buying === pack.key">Opening</template>
          <template v-else-if="pack.remainingToday === 0">None left today</template>
          <template v-else-if="!pack.affordable">Need {{ pack.price - (shop?.credits ?? 0) }} more</template>
          <template v-else>Buy for {{ pack.price }}</template>
        </button>

        <p v-if="pack.daily_limit" class="faint shop__note shop__note--limit">
          {{ pack.remainingToday }} of {{ pack.daily_limit }} left today.
        </p>
      </section>

      <p class="faint shop__foot">
        Credits come from duplicate pulls. Every pack you open counts toward the same
        Legendary and Icon pity as the daily one.
      </p>
    </template>
  </main>
</template>

<style scoped>
.shop-skeleton { height: 40vh; }

.shop__pack { display: grid; gap: 10px; margin-bottom: 14px; }

.shop__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.shop__name { font-size: 18px; }
.shop__slots { font-size: 12px; margin-top: 2px; }
.shop__price {
  font-size: 20px;
  font-weight: 700;
  color: var(--accent, #67d3f2);
  white-space: nowrap;
}
.shop__blurb { font-size: 13px; }

.shop__odds {
  display: flex;
  gap: 2px;
  height: 8px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--surface-2);
}
.shop__band { display: block; min-width: 2px; }
.shop__band--common { background: #5c6b84; }
.shop__band--rare { background: #58c4e6; }
.shop__band--epic { background: #a775f0; }
.shop__band--legendary { background: #e5b94f; }
.shop__band--icon { background: #64e8d6; }

.shop__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  list-style: none;
  padding: 0;
  margin: 0;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ink-dim, #8fa3c0);
}
.shop__legend li { display: flex; align-items: center; gap: 5px; }
.shop__dot { width: 8px; height: 8px; border-radius: 2px; }

.shop__note { font-size: 12px; }
.shop__note--limit { text-align: center; }
.shop__foot { font-size: 12px; text-align: center; margin: 18px 0 8px; }

.opened { display: grid; gap: 12px; }
.opened__head { font-size: 20px; }
.opened__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}
.opened__slot { display: grid; gap: 6px; }
.opened__dupe { font-size: 11px; text-align: center; }
.opened__actions { display: flex; gap: 10px; margin-top: 6px; }
.opened__actions .btn { flex: 1; text-align: center; }

@media (min-width: 640px) {
  .opened__grid { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }
}
</style>
