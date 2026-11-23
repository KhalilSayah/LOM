<script setup lang="ts">
/**
 * The pack shop: everything you can buy, on one turntable.
 *
 * The daily pack is not here, it is Home. Every pack still shows what it costs, how many
 * cards it gives and the odds per card, because the argument docs/02 section 5.2 makes about
 * pity — that hiding it is just anxiety — applies at least as much to spending Credits.
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
  pity: { legendaryIn: number; iconIn: number; legendaryEvery: number; iconEvery: number };
  packs: ShopPack[];
}

interface Opened {
  packType: string;
  packName: string;
  spent: number;
  creditsEarned: number;
  credits?: number;
  cards: any[];
}

/** Purchases at or above this price ask once before spending. */
const CONFIRM_AT = 1000;
const BANDS = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON'] as const;
const BAND_LABEL: Record<string, string> = { COMMON: 'Common', RARE: 'Rare', EPIC: 'Epic', LEGENDARY: 'Legendary', ICON: 'Icon' };

useHead({ title: 'Shop — LOM' });

const { credits: wallet } = useWallet();
const focus = useFocusMode();
const { gifts, drop: dropGift, refresh: refreshGifts } = useGiftSignal();

const shop = ref<Shop | null>(null);
const loading = ref(true);
const buying = ref<string | null>(null);
const openingGift = ref<string | null>(null);
const error = ref('');
const selected = ref(0);
const confirming = ref(false);
const nudged = ref(false);
const opened = ref<Opened | null>(null);
const from = ref<null | { cx: number; cy: number; w: number }>(null);
const carousel = ref<any>(null);

const packs = computed(() => shop.value?.packs ?? []);
const pack = computed(() => packs.value[selected.value] ?? null);
const gift = computed(() => gifts.value[0] ?? null);

watch(selected, () => { confirming.value = false; });
watch(opened, (o) => { focus.value = !!o; });
onBeforeUnmount(() => { focus.value = false; });

async function load() {
  try {
    shop.value = await $fetch<Shop>('/api/pack/shop');
    wallet.value = shop.value.credits;
    if (selected.value >= shop.value.packs.length) selected.value = 0;
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'Could not load the shop.';
  } finally {
    loading.value = false;
  }
}

function askOrBuy() {
  const p = pack.value;
  if (!p?.canBuy || buying.value) return;
  if (p.price >= CONFIRM_AT && !confirming.value) {
    confirming.value = true;
    return;
  }
  confirming.value = false;
  buy(p);
}

async function buy(p: ShopPack) {
  if (!p.canBuy || buying.value) return;
  buying.value = p.key;
  error.value = '';
  const rect = carousel.value?.frontRect?.() ?? null;
  try {
    const result = await $fetch<Opened>('/api/pack/buy', { method: 'POST', body: { packType: p.key } });
    if (typeof result.credits === 'number') wallet.value = result.credits;
    await carousel.value?.leave?.();
    from.value = rect;
    opened.value = { ...result, packType: result.packType || p.key };
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'The pack did not open.';
    await load();
  } finally {
    buying.value = null;
  }
}

async function openGift(g: Gift) {
  if (openingGift.value) return;
  openingGift.value = g.id;
  error.value = '';
  try {
    const result = await $fetch<Opened>('/api/gifts/open', { method: 'POST', body: { id: g.id } });
    dropGift(g.id);
    if (typeof result.credits === 'number') wallet.value = result.credits;
    from.value = null;
    opened.value = { ...result, packType: result.packType || g.packType };
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'The gift did not open.';
    // Either it was already open or the roll handed it back; the list is the truth.
    await refreshGifts();
  } finally {
    openingGift.value = null;
  }
}

/** What goes into the scene: each card, with what it turned into if you already had it. */
const entries = computed(() => (opened.value?.cards ?? [])
  .filter((c: any) => c?.card)
  .map((c: any) => ({
    card: c.card,
    note: c.wasDuplicate
      ? `Already yours: +${c.xpAwarded} XP${c.creditsAwarded ? `, +${c.creditsAwarded} credits` : ''}`
      : 'New',
  })));

async function closeOpened() {
  const paid = opened.value?.creditsEarned;
  opened.value = null;
  from.value = null;
  if (paid) playSound('coin');
  await load();
}

function tapFront() {
  nudged.value = false;
  requestAnimationFrame(() => { nudged.value = true; });
}

/** Odds as whole percentages, so the bar and the label agree. */
const odds = computed(() => {
  const p = pack.value;
  if (!p) return [];
  const total = BANDS.reduce((n, b) => n + (p.weights[b] ?? 0), 0) || 1;
  return BANDS
    .map((band) => ({ band, pct: ((p.weights[band] ?? 0) / total) * 100 }))
    .filter((o) => o.pct > 0);
});
const oddsLabel = computed(() => `Odds per card: ${odds.value.map((o) => `${BAND_LABEL[o.band]} ${o.pct.toFixed(o.pct < 1 ? 1 : 0)}%`).join(', ')}`);

const chips = computed(() => {
  const p = pack.value;
  if (!p) return [];
  const out = [p.one_per_role ? `${p.slots} cards, one per lane` : p.slots === 1 ? '1 card' : `${p.slots} cards`];
  if (p.floor_band) out.push(`1 ${BAND_LABEL[p.floor_band]} or better`);
  else if (p.max_band) out.push(`${BAND_LABEL[p.max_band]} at most`);
  if (p.daily_limit) out.push(`${p.remainingToday} of ${p.daily_limit} left today`);
  return out;
});

const buyLabel = computed(() => {
  const p = pack.value;
  if (!p) return '';
  if (buying.value === p.key) return 'Opening';
  if (p.remainingToday === 0) return 'None left today';
  if (!p.affordable) return `Need ${(p.price - (shop.value?.credits ?? 0)).toLocaleString('en')} more`;
  if (confirming.value) return `Spend ${p.price.toLocaleString('en')}`;
  return `Buy for ${p.price.toLocaleString('en')}`;
});

const share = (left: number, every: number) => `${Math.round(((every - left) / Math.max(1, every)) * 100)}%`;

onMounted(() => {
  preloadPackSounds();
  load();
});
</script>

<template>
  <main v-if="opened" class="shop-reveal">
    <PackScene :cards="entries" :pack-type="opened.packType" :from="from" @kept="closeOpened" />
  </main>

  <main v-else class="page--screen shop">
    <header class="shop__head">
      <h1>Shop</h1>
      <NuxtLink class="btn btn--quiet" to="/pack" data-sound="back">Daily pack</NuxtLink>
    </header>

    <p v-if="error" class="notice notice--bad shop__error" role="alert">{{ error }}</p>

    <section v-if="gift" class="shop__gift" aria-label="Gift">
      <span class="tag tag--new">Gift</span>
      <p><b>{{ gift.title }}</b><span class="faint">{{ gift.packName }}<template v-if="gifts.length > 1"> · {{ gifts.length - 1 }} more</template></span></p>
      <button class="btn btn--sm" type="button" data-sound="gift" :disabled="openingGift !== null || buying !== null" @click="openGift(gift)">
        {{ openingGift === gift.id ? 'Opening' : 'Open' }}
      </button>
    </section>

    <div v-if="loading" class="skeleton shop__skeleton" />

    <template v-else-if="pack">
      <div class="shop__ring">
        <PackCarousel ref="carousel" v-model="selected" :packs="packs" @front="tapFront" />
      </div>

      <section class="shop__info" aria-live="polite">
        <h2 class="shop__name">{{ pack.name }}</h2>
        <p v-if="pack.blurb" class="shop__blurb">{{ pack.blurb }}</p>
        <ul class="shop__chips">
          <li v-for="c in chips" :key="c">{{ c }}</li>
        </ul>

        <div class="shop__odds">
          <div class="odds" role="img" :aria-label="oddsLabel">
            <span v-for="o in odds" :key="o.band" class="odds__band" :class="`odds__band--${o.band.toLowerCase()}`" :style="{ flexGrow: Math.max(o.pct, 1.2) }" />
          </div>
          <ul class="legend" aria-hidden="true">
            <li v-for="o in odds" :key="o.band"><i class="gem" :class="`gem--${o.band.toLowerCase()}`" />{{ o.pct.toFixed(o.pct < 1 ? 1 : 0) }}%</li>
          </ul>
        </div>

        <div class="shop__cta" :class="{ 'is-pair': confirming }">
          <button
            class="btn btn--gold btn--lg shop__buy" :class="{ 'is-nudged': nudged }" type="button"
            :data-sound="confirming || pack.price < CONFIRM_AT ? 'coin' : 'select'"
            :disabled="!pack.canBuy || buying !== null"
            @click="askOrBuy" @animationend="nudged = false"
          >{{ buyLabel }}</button>
          <button v-if="confirming && buying === null" class="btn btn--ghost btn--lg" type="button" @click="confirming = false">Cancel</button>
        </div>
        <p v-if="confirming && buying === null" class="shop__note" role="status">
          You will have {{ ((shop?.credits ?? 0) - pack.price).toLocaleString('en') }} left.
        </p>
      </section>

      <footer v-if="shop?.pity" class="shop__foot">
        <div class="shop__meter">
          <p><span>Legendary within</span><b class="tnum">{{ shop.pity.legendaryIn }}</b></p>
          <div class="meter"><i :style="{ width: share(shop.pity.legendaryIn, shop.pity.legendaryEvery) }" /></div>
        </div>
        <div class="shop__meter">
          <p><span>Icon within</span><b class="tnum">{{ shop.pity.iconIn }}</b></p>
          <div class="meter meter--prism"><i :style="{ width: share(shop.pity.iconIn, shop.pity.iconEvery) }" /></div>
        </div>
        <nav class="shop__links" aria-label="More about Credits">
          <NuxtLink to="/odds">Odds and pity</NuxtLink>
          <NuxtLink to="/sponsors">Sponsors</NuxtLink>
          <NuxtLink to="/wallet">Wallet</NuxtLink>
        </nav>
      </footer>
    </template>

    <div v-else class="empty shop__skeleton"><p>No packs are on sale right now.</p></div>
  </main>
</template>

<style scoped>
.shop { display: flex; flex-direction: column; gap: 6px; padding: 0 max(16px, env(safe-area-inset-left, 0px)) 2px; overflow: hidden; }
.shop__head { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; width: min(100%, 720px); min-height: 50px; margin-inline: auto; }
.shop__head h1 { font-size: 30px; font-stretch: 76%; font-weight: 850; }
.shop__head .btn { min-height: 38px; padding: 0 13px; }
.shop__error { flex: none; margin: 0; }
.shop__skeleton { flex: 1; min-height: 0; }

.shop__gift { flex: none; display: flex; align-items: center; gap: 10px; width: min(100%, 460px); margin-inline: auto; padding: 7px 8px 7px 11px; background: linear-gradient(165deg, #1a2235, #0c121e 70%); border: 1px solid rgba(216, 176, 100, 0.35); border-radius: var(--radius); }
.shop__gift p { flex: 1; min-width: 0; display: grid; margin: 0; line-height: 1.2; }
.shop__gift b { overflow: hidden; font-size: 13.5px; font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }
.shop__gift span.faint { font-size: 12px; }

.shop__ring { flex: 1; min-height: 0; margin-inline: calc(-1 * max(16px, env(safe-area-inset-left, 0px))); }

.shop__info { flex: none; display: grid; justify-items: center; gap: 5px; text-align: center; }
.shop__name { margin: 0; font-size: clamp(26px, 7.4vw, 33px); line-height: 1; font-stretch: 76%; font-weight: 850; }
.shop__blurb { margin: 0; max-width: 42ch; font-size: 13.5px; line-height: 1.32; color: var(--ink-2); text-wrap: balance; }
.shop__chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 5px; margin: 1px 0 0; padding: 0; list-style: none; }
.shop__chips li { padding: 2px 7px; border: 1px solid var(--line-2); border-radius: 2px; background: var(--bg-2); font-size: 11.5px; font-weight: 620; }

.shop__odds { display: grid; gap: 4px; width: min(100%, 380px); margin-top: 2px; }
.odds { display: flex; gap: 2px; height: 5px; border-radius: 3px; overflow: hidden; background: var(--bg-4); }
.odds__band { display: block; min-width: 3px; }
.odds__band--common { background: var(--r-common); }
.odds__band--rare { background: var(--r-rare); }
.odds__band--epic { background: var(--r-epic); }
.odds__band--legendary { background: var(--r-legendary); }
.odds__band--icon { background: var(--prism); }
.legend { display: flex; flex-wrap: wrap; justify-content: center; gap: 2px 10px; margin: 0; padding: 0; list-style: none; font-size: 11.5px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.legend li { display: inline-flex; align-items: center; gap: 4px; }
.legend .gem { width: 8px; height: 8px; }

.shop__cta { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; width: min(100%, 380px); margin-top: 3px; }
.shop__buy { grid-column: 1 / -1; width: 100%; }
.shop__cta.is-pair .shop__buy { grid-column: auto; padding-inline: 10px; }
.shop__buy.is-nudged { animation: nudge 0.34s var(--ease-out); }
@keyframes nudge { 40% { transform: translateY(-3px); } }
.shop__note { margin: 0; font-size: 12.5px; color: var(--ink-2); }

.shop__foot { flex: none; display: grid; grid-template-columns: 1fr 1fr; gap: 3px 14px; width: min(100%, 380px); margin: 2px auto 0; }
.shop__meter p { display: flex; justify-content: space-between; align-items: baseline; margin: 0 0 3px; font-size: 11.5px; color: var(--ink-3); }
.shop__meter b { font-size: 12px; color: var(--ink-1); }
.shop__links { grid-column: 1 / -1; display: flex; justify-content: center; gap: 14px; font-size: 12px; color: var(--ink-3); }
.shop__links a { padding: 3px 2px; text-decoration: underline; text-underline-offset: 3px; }
.shop__links a:hover { color: var(--ink-1); }

@media (max-height: 760px) { .shop__blurb { display: none; } }
@media (max-height: 680px) {
  .shop__head { min-height: 42px; }
  .shop__head h1 { font-size: 25px; }
  .legend, .shop__links { display: none; }
  .shop__buy, .shop__cta .btn { min-height: 46px; }
}
@media (max-height: 590px) { .shop__foot { display: none; } }
@media (prefers-reduced-motion: reduce) { .shop__buy.is-nudged { animation: none; } }
</style>
