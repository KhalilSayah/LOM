<script setup lang="ts">
/**
 * The pack shop.
 *
 * Every pack shows what it costs, how many cards it gives and the odds behind each slot,
 * because the argument docs/02 section 5.2 makes about pity — that hiding it is just
 * anxiety — applies at least as much to something you are about to spend Credits on.
 */

import type { Gift } from '~/composables/useGiftSignal';

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

useHead({ title: 'Shop — LOM' });
const { credits: wallet } = useWallet();
const BAND_LABEL: Record<string, string> = { COMMON: 'Common', RARE: 'Rare', EPIC: 'Epic', LEGENDARY: 'Legendary', ICON: 'Icon' };
/** Each pack type is a palette on the same foil wrapper. */
const kindOf = (key: string) => (key || '').toLowerCase();

const BANDS = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON'] as const;

const shop = ref<Shop | null>(null);
const loading = ref(true);
const buying = ref<string | null>(null);
const error = ref('');
const opened = ref<null | { packName: string; spent: number; creditsEarned: number; cards: any[] }>(null);

/**
 * Gifted packs open here rather than on the pack screen, because this is the one screen
 * that already reveals more than one card at a time — and a Signing pack is five.
 */
const { gifts, drop: dropGift, refresh: refreshGifts } = useGiftSignal();
const openingGift = ref<string | null>(null);

async function load() {
  try {
    shop.value = await $fetch<Shop>('/api/pack/shop');
    wallet.value = shop.value.credits;
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

async function openGift(gift: Gift) {
  if (openingGift.value) return;
  openingGift.value = gift.id;
  error.value = '';
  try {
    opened.value = await $fetch('/api/gifts/open', { method: 'POST', body: { id: gift.id } });
    dropGift(gift.id);
    // Duplicates in a gifted pack still pay Credits, so the balance on screen has moved.
    await load();
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'The gift did not open.';
    // Either it was already open or the roll handed it back; the list is the truth.
    await refreshGifts();
  } finally {
    openingGift.value = null;
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
  <main class="page page--wide shop">
    <header class="topbar">
      <h1>Shop</h1>
      <span class="topbar__meta">Credits come from duplicates</span>
    </header>

    <p v-if="error" class="notice notice--bad">{{ error }}</p>

    <div v-if="loading" class="skeleton shop-skeleton" />

    <!-- what just came out -->
    <section v-else-if="opened" class="opened">
      <p class="label">{{ opened.packName }}</p>
      <h2 class="opened__head">{{ opened.cards.length }} {{ opened.cards.length === 1 ? 'card' : 'cards' }}</h2>
      <div class="opened__grid">
        <article v-for="c in opened.cards" :key="c.slot" class="opened__slot">
          <LomCard v-if="c.card" :card="c.card" />
          <p v-if="c.wasDuplicate" class="opened__dupe">
            Duplicate: +{{ c.xpAwarded }} XP<span v-if="c.creditsAwarded">, +{{ c.creditsAwarded }} credits</span>
          </p>
          <p v-else class="opened__new"><span class="tag tag--new">New</span></p>
        </article>
      </div>
      <p v-if="opened.creditsEarned" class="notice">
        Duplicates paid back <strong>{{ opened.creditsEarned }} credits</strong>.
      </p>
      <div class="opened__actions">
        <button class="btn btn--ghost" type="button" @click="opened = null">Back to the shop</button>
        <NuxtLink class="btn" to="/collection">See them in Cards</NuxtLink>
      </div>
    </section>

    <template v-else>
      <!-- gifts first: they are free, and they are the reason most people are on this screen -->
      <section v-for="g in gifts" :key="g.id" class="offer offer--gift">
        <div class="offer__art"><div class="pk" :data-kind="kindOf(g.packType)" aria-hidden="true"><span class="pk__seal" /><span class="pk__mark" /><b class="pk__name">{{ g.packName.replace(' pack', '') }}</b></div></div>
        <div class="offer__body">
          <p class="offer__kicker"><span class="tag tag--new">Gift</span></p>
          <h2 class="offer__name">{{ g.title }}</h2>
          <p class="offer__what">
            {{ g.packName }} · {{ g.onePerRole ? `${g.slots} cards, one per lane` : g.slots === 1 ? '1 card' : `${g.slots} cards` }}
          </p>
          <p v-if="g.body" class="offer__blurb">{{ g.body }}</p>
          <button class="btn offer__cta" type="button" :disabled="openingGift !== null || buying !== null" @click="openGift(g)">
            {{ openingGift === g.id ? 'Opening' : 'Open gift' }}
          </button>
        </div>
      </section>

      <section v-for="pack in shop?.packs || []" :key="pack.key" class="offer">
        <div class="offer__art"><div class="pk" :data-kind="kindOf(pack.key)" aria-hidden="true"><span class="pk__seal" /><span class="pk__mark" /><b class="pk__name">{{ pack.name.replace(' pack', '') }}</b></div></div>
        <div class="offer__body">
          <div class="offer__head">
            <div>
              <h2 class="offer__name">{{ pack.name }}</h2>
              <p class="offer__what">{{ label(pack) }}</p>
            </div>
            <span class="offer__price tnum"><i class="coin coin--s" aria-hidden="true" />{{ pack.price.toLocaleString('en') }}</span>
          </div>

          <p v-if="pack.blurb" class="offer__blurb">{{ pack.blurb }}</p>

          <div class="odds" role="img" :aria-label="`Odds per card: ${odds(pack).map(o => `${BAND_LABEL[o.band]} ${o.pct.toFixed(o.pct < 1 ? 1 : 0)}%`).join(', ')}`">
            <span v-for="o in odds(pack)" :key="o.band" class="odds__band" :class="`odds__band--${o.band.toLowerCase()}`" :style="{ flexGrow: Math.max(o.pct, 1.2) }" />
          </div>
          <ul class="legend" aria-hidden="true">
            <li v-for="o in odds(pack)" :key="o.band">
              <i class="gem" :class="`gem--${o.band.toLowerCase()}`" />{{ o.pct.toFixed(o.pct < 1 ? 1 : 0) }}%
            </li>
          </ul>

          <p v-if="pack.floor_band" class="offer__note">One card is {{ BAND_LABEL[pack.floor_band] }} or better.</p>
          <p v-else-if="pack.max_band" class="offer__note">Nothing above {{ BAND_LABEL[pack.max_band] }}.</p>

          <div class="offer__foot">
            <button
              class="btn btn--gold offer__cta"
              :class="{ 'btn--off': !pack.canBuy }"
              type="button"
              :disabled="!pack.canBuy || buying !== null"
              @click="buy(pack)"
            >
              <template v-if="buying === pack.key">Opening</template>
              <template v-else-if="pack.remainingToday === 0">None left today</template>
              <template v-else-if="!pack.affordable">Need {{ (pack.price - (shop?.credits ?? 0)).toLocaleString('en') }} more</template>
              <template v-else>Buy · {{ pack.price.toLocaleString('en') }}</template>
            </button>
            <p v-if="pack.daily_limit" class="offer__note">{{ pack.remainingToday }} of {{ pack.daily_limit }} left today</p>
          </div>
        </div>
      </section>

      <p class="shop__foot faint">
        Credits come from duplicate pulls. Every card from every pack counts toward the same
        Legendary and Icon guarantee as the daily one.
      </p>
    </template>
  </main>
</template>

<style scoped>
.shop-skeleton { height: 40vh; }
.topbar__credits { align-self: center; }

.offer {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 18px;
  padding: 18px;
  margin-bottom: 12px;
  background: var(--bg-2);
  border: 1px solid var(--line-1);
  border-radius: var(--radius);
}
.offer--gift { background: linear-gradient(165deg, #1a2235, #0c121e 70%); border-color: rgba(216, 176, 100, 0.35); }
.offer__kicker { margin: 0 0 6px; }
.offer__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.offer__name { font-size: 22px; line-height: 1; }
.offer__what { margin: 4px 0 0; font-size: 12.5px; color: var(--ink-3); }
.offer__blurb { margin: 10px 0 0; font-size: 13.5px; color: var(--ink-2); }
.offer__price { display: inline-flex; align-items: center; gap: 6px; font-stretch: 80%; font-weight: 820; font-size: 22px; color: var(--gold-1); white-space: nowrap; }
.offer__note { margin: 8px 0 0; font-size: 12.5px; color: var(--ink-3); }
.offer__foot { margin-top: 14px; }
.offer__cta { margin-top: 14px; }
.offer__foot .offer__cta { margin-top: 0; }

.odds { display: flex; gap: 2px; height: 6px; margin-top: 14px; border-radius: 3px; overflow: hidden; background: var(--bg-4); }
.odds__band { display: block; min-width: 3px; }
.odds__band--common { background: var(--r-common); }
.odds__band--rare { background: var(--r-rare); }
.odds__band--epic { background: var(--r-epic); }
.odds__band--legendary { background: var(--r-legendary); }
.odds__band--icon { background: var(--prism); }
.legend { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.legend li { display: inline-flex; align-items: center; gap: 5px; }
.legend .gem { width: 9px; height: 9px; }

/* the wrapper, small: same foil stock as the daily pack, one palette per type */
.offer__art { container-type: inline-size; }
.pk {
  --hi: #26365a; --lo: #0a101c; --acc: var(--gold-2);
  position: relative;
  aspect-ratio: 5 / 8;
  overflow: hidden;
  background: radial-gradient(120% 70% at 50% 36%, color-mix(in srgb, var(--acc) 22%, transparent), transparent 62%), linear-gradient(165deg, var(--hi), var(--lo) 80%);
  box-shadow: 0 10px 20px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(255, 255, 255, 0.06);
}
.pk[data-kind='scouting'] { --hi: #3a4a63; --lo: #121a26; --acc: #9fb3cf; }
.pk[data-kind='signing'] { --hi: #145a5c; --lo: #06171b; --acc: var(--teal-2); }
.pk[data-kind='standard'] { --hi: #2b2350; --lo: #0d0a1c; --acc: #b58bff; }
.pk[data-kind='legacy'] { --hi: #2c2416; --lo: #070605; --acc: #f2c14e; }
.pk::after { content: ''; position: absolute; inset: 0; background: linear-gradient(115deg, transparent 30%, rgba(255, 255, 255, 0.14) 42%, transparent 56%); }
.pk__seal { position: absolute; inset: 0 0 auto; height: 9%; background: repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.16) 0 1px, transparent 1px 4px); }
.pk__mark { position: absolute; left: 50%; top: 32%; width: 30%; aspect-ratio: 1; transform: translate(-50%, -50%) rotate(45deg); border: 1.5px solid var(--acc); }
.pk__mark::after { content: ''; position: absolute; inset: 24%; background: var(--acc); }
.pk__name { position: absolute; left: 0; right: 0; top: 56%; text-align: center; font-stretch: 75%; font-weight: 860; font-size: 15cqw; text-transform: uppercase; color: color-mix(in srgb, var(--acc) 40%, #fff); }

.opened { display: grid; gap: 14px; }
.opened__head { font-size: 30px; }
.opened__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 16px; }
.opened__slot { display: grid; gap: 8px; align-content: start; }
.opened__dupe { margin: 0; font-size: 12px; color: var(--ink-3); text-align: center; }
.opened__new { margin: 0; text-align: center; }
.opened__actions { display: flex; flex-wrap: wrap; gap: 10px; }

.shop__foot { font-size: 12.5px; text-align: center; margin: 20px 0 8px; }

@media (min-width: 720px) {
  .offer { grid-template-columns: 140px minmax(0, 1fr); gap: 26px; padding: 22px; }
  .offer__foot { display: flex; align-items: center; gap: 16px; }
  .offer__foot .offer__note { margin: 0; }
}
</style>
