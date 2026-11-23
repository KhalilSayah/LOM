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

const pct = (n: number) => `${+n.toFixed(1)}%`;

/** Odds per card, so the bar and the label agree. */
const odds = computed(() => {
  const p = pack.value;
  if (!p) return [];
  const total = BANDS.reduce((n, b) => n + (p.weights[b] ?? 0), 0) || 1;
  return BANDS.map((band) => ({ band, pct: ((p.weights[band] ?? 0) / total) * 100 }));
});
const oddsLabel = computed(() => `Odds per card: ${odds.value.filter((o) => o.pct > 0).map((o) => `${BAND_LABEL[o.band]} ${pct(o.pct)}`).join(', ')}`);

/** Always the same three facts in the same three places, so nothing moves on a turn. */
const facts = computed(() => {
  const p = pack.value;
  if (!p) return [];
  return [
    p.one_per_role ? `${p.slots}, one per lane` : p.slots === 1 ? '1 card' : `${p.slots} cards`,
    p.floor_band ? `1 ${BAND_LABEL[p.floor_band]}+` : p.max_band ? `Up to ${BAND_LABEL[p.max_band]}` : 'All rarities',
    p.daily_limit ? `${p.remainingToday} of ${p.daily_limit} today` : 'No daily limit',
  ];
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
    <p v-if="error" class="notice notice--bad shop__error" role="alert">{{ error }}</p>

    <section v-if="gift" class="shop__gift" aria-label="Gift">
      <span class="tag tag--new">Gift</span>
      <p><b>{{ gift.title }}</b><span class="faint">{{ gift.packName }}<template v-if="gifts.length > 1"> · {{ gifts.length - 1 }} more</template></span></p>
      <button class="btn btn--sm" type="button" data-sound="gift" :disabled="openingGift !== null || buying !== null" @click="openGift(gift)">
        {{ openingGift === gift.id ? 'Opening' : 'Open' }}
      </button>
    </section>

    <header class="shop__top">
      <div class="shop__bar">
        <h1>Shop</h1>
        <h2 v-if="pack" :key="pack.key" class="shop__name" aria-live="polite">{{ pack.name }}</h2>
        <NuxtLink class="shop__daily" to="/pack" data-sound="back" aria-label="Back to the daily pack">Daily</NuxtLink>
      </div>

      <template v-if="pack && !loading">
        <!-- Every description sits in the same cell, so the cell is always as tall as the longest. -->
        <div class="shop__blurbs">
          <p v-for="p in packs" :key="p.key" :class="{ 'is-on': p.key === pack.key }" :aria-hidden="p.key !== pack.key">{{ p.blurb }}</p>
        </div>
        <ul class="shop__facts">
          <li v-for="(f, i) in facts" :key="i">{{ f }}</li>
        </ul>
      </template>
    </header>

    <div v-if="loading" class="skeleton shop__skeleton" />

    <template v-else-if="pack">
      <div class="shop__ring">
        <PackCarousel ref="carousel" v-model="selected" :packs="packs" @front="tapFront" />
      </div>

      <section class="shop__bottom" aria-label="Buy this pack">
        <div class="shop__odds">
          <div class="odds" role="img" :aria-label="oddsLabel">
            <span
              v-for="o in odds" v-show="o.pct > 0" :key="o.band" class="odds__band"
              :class="`odds__band--${o.band.toLowerCase()}`" :style="{ flexGrow: Math.max(o.pct, 1.2) }"
            />
          </div>
          <ul class="legend" aria-hidden="true">
            <li v-for="o in odds" :key="o.band" :class="{ 'is-off': !o.pct }"><i class="gem" :class="`gem--${o.band.toLowerCase()}`" />{{ o.pct ? pct(o.pct) : '–' }}</li>
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

        <!-- The confirmation takes the guarantees' place, so the button never pushes anything. -->
        <div class="shop__after">
          <footer v-if="shop?.pity" class="shop__foot" :class="{ 'is-under': confirming && buying === null }">
            <div class="shop__meter">
              <p><span>Legendary within</span><b class="tnum">{{ shop.pity.legendaryIn }}</b></p>
              <div class="meter"><i :style="{ width: share(shop.pity.legendaryIn, shop.pity.legendaryEvery) }" /></div>
            </div>
            <div class="shop__meter">
              <p><span>Icon within</span><b class="tnum">{{ shop.pity.iconIn }}</b></p>
              <div class="meter meter--prism"><i :style="{ width: share(shop.pity.iconIn, shop.pity.iconEvery) }" /></div>
            </div>
            <!-- Split around the raised Battle button in the tab bar. -->
            <nav class="shop__links" aria-label="More about Credits">
              <NuxtLink to="/odds">Odds and pity</NuxtLink>
              <span>
                <NuxtLink to="/sponsors">Sponsors</NuxtLink>
                <NuxtLink to="/wallet">Wallet</NuxtLink>
              </span>
            </nav>
          </footer>
          <p v-if="confirming && buying === null" class="shop__note" role="status">
            You will have <b class="tnum">{{ ((shop?.credits ?? 0) - pack.price).toLocaleString('en') }}</b> left.
          </p>
        </div>
      </section>
    </template>

    <div v-else class="empty shop__skeleton"><p>No packs are on sale right now.</p></div>
  </main>
</template>

<style scoped>
/* What it is, on top. The pack, as large as the screen allows. What it costs, below. */
.shop { --shop-w: min(100%, 440px); display: flex; flex-direction: column; gap: 6px; padding: 4px max(16px, env(safe-area-inset-left, 0px)) 2px; overflow: hidden; }
.shop__error { flex: none; margin: 0; }
.shop__skeleton { flex: 1; min-height: 0; }

.shop__gift { flex: none; display: flex; align-items: center; gap: 10px; width: var(--shop-w); margin-inline: auto; padding: 5px 6px 5px 10px; background: linear-gradient(165deg, #1a2235, #0c121e 70%); border: 1px solid rgba(216, 176, 100, 0.35); border-radius: var(--radius); }
.shop__gift p { flex: 1; min-width: 0; display: grid; margin: 0; line-height: 1.2; }
.shop__gift b { overflow: hidden; font-size: 13px; font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }
.shop__gift span.faint { font-size: 11.5px; }

.shop__top { flex: none; display: grid; gap: 5px; width: var(--shop-w); margin-inline: auto; }
.shop__bar { display: grid; grid-template-columns: minmax(52px, 1fr) minmax(0, auto) minmax(52px, 1fr); align-items: center; gap: 6px; min-height: 36px; }
.shop__bar h1 { grid-column: 1; font-size: 15px; font-stretch: 100%; font-weight: 720; color: var(--ink-3); }
.shop__name { grid-column: 2; margin: 0; overflow: hidden; font-size: clamp(27px, 8vw, 34px); line-height: 1.05; font-stretch: 76%; font-weight: 850; text-align: center; text-overflow: ellipsis; white-space: nowrap; animation: shop-in 180ms var(--ease-out); }
.shop__daily { grid-column: 3; justify-self: end; padding: 8px 0 8px 8px; font-size: 13px; font-weight: 650; color: var(--ink-2); text-decoration: underline; text-decoration-color: var(--line-3); text-underline-offset: 3px; }
.shop__daily:hover { color: var(--ink-1); }
@keyframes shop-in { from { opacity: 0; } }

.shop__blurbs { display: grid; text-align: center; }
.shop__blurbs p { grid-area: 1 / 1; margin: 0 auto; max-width: 44ch; font-size: 13px; line-height: 1.32; color: var(--ink-2); text-wrap: balance; visibility: hidden; opacity: 0; transition: opacity 180ms linear; }
.shop__blurbs p.is-on { visibility: visible; opacity: 1; }

.shop__facts { display: grid; grid-template-columns: 1fr 1fr 1fr; margin: 0; padding: 0; list-style: none; border-block: 1px solid var(--line-1); }
.shop__facts li { min-width: 0; padding: 4px 3px; overflow: hidden; font-size: 12.5px; font-stretch: 86%; font-weight: 680; line-height: 1.25; text-align: center; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-1); }
.shop__facts li + li { border-left: 1px solid var(--line-1); }

.shop__ring { flex: 1; min-height: 0; margin-inline: calc(-1 * max(16px, env(safe-area-inset-left, 0px))); }

.shop__bottom { flex: none; display: grid; gap: 6px; width: min(100%, 400px); margin-inline: auto; }
.shop__odds { display: grid; gap: 4px; }
.odds { display: flex; gap: 2px; height: 5px; border-radius: 3px; overflow: hidden; background: var(--bg-4); }
.odds__band { display: block; min-width: 3px; flex-basis: 0; transition: flex-grow 220ms var(--ease-out); }
.odds__band--common { background: var(--r-common); }
.odds__band--rare { background: var(--r-rare); }
.odds__band--epic { background: var(--r-epic); }
.odds__band--legendary { background: var(--r-legendary); }
.odds__band--icon { background: var(--prism); }
.legend { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); margin: 0; padding: 0; list-style: none; font-size: 11.5px; line-height: 1.2; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.legend li { display: inline-flex; align-items: center; justify-content: center; gap: 4px; white-space: nowrap; }
.legend li.is-off { opacity: 0.32; }
.legend .gem { flex: none; width: 8px; height: 8px; }

.shop__cta { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.shop__buy { grid-column: 1 / -1; width: 100%; }
.shop__cta.is-pair .shop__buy { grid-column: auto; padding-inline: 10px; }
.shop__buy.is-nudged { animation: nudge 0.34s var(--ease-out); }
@keyframes nudge { 40% { transform: translateY(-3px); } }

.shop__after { display: grid; }
.shop__foot, .shop__note { grid-area: 1 / 1; }
.shop__foot { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 14px; }
.shop__foot.is-under { visibility: hidden; }
.shop__note { align-self: center; margin: 0; font-size: 13px; line-height: 1.1; text-align: center; color: var(--ink-2); }
.shop__note b { color: var(--gold-1); }
.shop__meter p { display: flex; justify-content: space-between; align-items: baseline; margin: 0 0 3px; font-size: 11.5px; line-height: 1.2; color: var(--ink-3); }
.shop__meter b { font-size: 12px; color: var(--ink-1); }
.shop__links { grid-column: 1 / -1; display: flex; justify-content: space-between; font-size: 12px; color: var(--ink-3); }
.shop__links span { display: inline-flex; gap: 12px; }
.shop__links a { padding: 2px; text-decoration: underline; text-underline-offset: 3px; }
.shop__links a:hover { color: var(--ink-1); }

/* Short phones: the words go first, then the links. The pack keeps its room. */
@media (max-height: 720px) {
  .shop__blurbs, .shop__links { display: none; }
  .shop__meter .meter { display: none; }
  .shop__meter p { margin: 0; }
  /* Clear the raised Battle button once the links stop doing it. */
  .shop { padding-bottom: 20px; }
}
@media (max-height: 720px) and (min-width: 1024px) { .shop { padding-bottom: 2px; } }
@media (max-height: 640px) {
  .shop { gap: 4px; padding-top: 2px; }
  .shop__bar { min-height: 32px; }
  .shop__name { font-size: 25px; }
  .shop__gift { padding-block: 3px; }
  .shop__gift span.faint { display: none; }
  .shop__gift .btn { min-height: 30px; }
  .shop__buy, .shop__cta .btn { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .shop__buy.is-nudged, .shop__name { animation: none; }
  .shop__blurbs p, .odds__band { transition: none; }
}
</style>
