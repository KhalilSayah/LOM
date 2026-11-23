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
  pity: { legendaryIn: number; iconIn: number; legendaryEvery: number; iconEvery: number };
  packs: ShopPack[];
}

/** Purchases at or above this price ask once before spending. */
const CONFIRM_AT = 1000;

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

/** The pack waiting on "are you sure", for the expensive ones. */
const confirming = ref<string | null>(null);

function askOrBuy(pack: ShopPack) {
  if (!pack.canBuy || buying.value) return;
  if (pack.price >= CONFIRM_AT && confirming.value !== pack.key) {
    confirming.value = pack.key;
    return;
  }
  confirming.value = null;
  buy(pack);
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
/**
 * A bought pack comes out face down, and the cards are turned one at a time: by tapping
 * them, or with "Reveal all", which goes left to right. They are laid out worst to best,
 * so the last card turned is the one worth waiting for. The backs glow in their rarity,
 * the same tease a sealed pack gives: you know something good is in there before you
 * know who.
 */
const ORDER = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON'];
const rarityOf = (c: any) => String(c?.card?.rarity || c?.rarity || 'COMMON').toUpperCase();

const laidOut = computed(() => (opened.value?.cards ?? [])
  .map((c: any, i: number) => ({ ...c, _i: i }))
  .sort((x: any, y: any) => ORDER.indexOf(rarityOf(x)) - ORDER.indexOf(rarityOf(y))));

const turned = ref<Set<number>>(new Set());
const allTurned = computed(() => !!opened.value && turned.value.size >= laidOut.value.length);
let revealTimers: ReturnType<typeof setTimeout>[] = [];

function turn(i: number) {
  if (turned.value.has(i)) return;
  const next = new Set(turned.value);
  next.add(i);
  turned.value = next;
  const card = laidOut.value.find((c: any) => c._i === i);
  const r = rarityOf(card);
  playSound(ORDER.indexOf(r) >= 2 ? revealSoundFor(r) : 'cardFlip');
}

function revealAll() {
  revealTimers.forEach(clearTimeout);
  const left = laidOut.value.filter((c: any) => !turned.value.has(c._i));
  left.forEach((c: any, n: number) => {
    // The last one waits a beat longer: it is the best card in the pack.
    const extra = n === left.length - 1 && left.length > 1 ? 420 : 0;
    revealTimers.push(setTimeout(() => turn(c._i), n * 340 + extra));
  });
}

watch(opened, (o) => {
  revealTimers.forEach(clearTimeout);
  turned.value = new Set();
  if (o?.cards?.length) playSound('packTear');
});

watch(allTurned, (done) => {
  if (done && opened.value?.creditsEarned) setTimeout(() => playSound('coin'), 500);
});

onBeforeUnmount(() => revealTimers.forEach(clearTimeout));
</script>


<template>
  <main class="page page--wide shop">
    <header class="topbar">
      <h1>Shop</h1>
      <span class="topbar__meta">
        <NuxtLink to="/wallet">Wallet</NuxtLink>
        <NuxtLink to="/odds">Odds and pity</NuxtLink>
      </span>
    </header>

    <p v-if="error" class="notice notice--bad">{{ error }}</p>

    <div v-if="loading" class="skeleton shop-skeleton" />

    <!-- what just came out -->
    <section v-else-if="opened" class="opened">
      <header class="opened__top">
        <div>
          <p class="label">{{ opened.packName }}</p>
          <h2 class="opened__head">
            <template v-if="allTurned">{{ opened.cards.length }} {{ opened.cards.length === 1 ? 'card' : 'cards' }}</template>
            <template v-else>Tap a card to turn it</template>
          </h2>
        </div>
        <button v-if="!allTurned" class="btn btn--gold" type="button" data-sound="none" @click="revealAll">
          Reveal all
        </button>
      </header>

      <ul class="opened__grid">
        <li v-for="(c, n) in laidOut" :key="c._i" class="opened__slot">
          <button
            v-if="!turned.has(c._i)"
            class="facedown" type="button" data-sound="none"
            :data-rarity="rarityOf(c).toLowerCase()"
            :aria-label="'Turn card ' + (n + 1)"
            @click="turn(c._i)"
          >
            <span class="facedown__mark" aria-hidden="true" />
            <span class="facedown__word" aria-hidden="true">LOM</span>
          </button>
          <div v-else class="opened__face" :data-rarity="rarityOf(c).toLowerCase()">
            <LomCard v-if="c.card" :card="c.card" />
            <p v-if="c.wasDuplicate" class="opened__dupe">
              Already yours: +{{ c.xpAwarded }} XP<span v-if="c.creditsAwarded">, +{{ c.creditsAwarded }} credits</span>
            </p>
            <p v-else class="opened__new"><span class="tag tag--new">New</span></p>
          </div>
        </li>
      </ul>

      <template v-if="allTurned">
        <p v-if="opened.creditsEarned" class="notice">
          Duplicates paid back <strong>{{ opened.creditsEarned }} credits</strong>.
        </p>
        <div class="opened__actions">
          <button class="btn btn--ghost" type="button" @click="opened = null">Back to the shop</button>
          <NuxtLink v-if="opened.cards.length >= 5" class="btn btn--ghost" to="/roster">Set your five</NuxtLink>
          <NuxtLink class="btn" to="/collection">See them in Cards</NuxtLink>
        </div>
      </template>
    </section>

    <template v-else>
      <!-- pity is shared by every pack, so it sits above all of them -->
      <section v-if="shop?.pity" class="pitybar" aria-label="Your pity counters">
        <div>
          <p><span>Legendary within</span><b class="tnum">{{ shop.pity.legendaryIn }} {{ shop.pity.legendaryIn === 1 ? 'card' : 'cards' }}</b></p>
          <div class="meter"><i :style="{ width: `${Math.round(((shop.pity.legendaryEvery - shop.pity.legendaryIn) / shop.pity.legendaryEvery) * 100)}%` }" /></div>
        </div>
        <div>
          <p><span>Icon within</span><b class="tnum">{{ shop.pity.iconIn }} {{ shop.pity.iconIn === 1 ? 'card' : 'cards' }}</b></p>
          <div class="meter meter--prism"><i :style="{ width: `${Math.round(((shop.pity.iconEvery - shop.pity.iconIn) / shop.pity.iconEvery) * 100)}%` }" /></div>
        </div>
        <p class="pitybar__note">Every card from every pack counts. When a guarantee comes due it overrides the pack's own odds, ceiling included.</p>
      </section>

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
          <button class="btn offer__cta" type="button" data-sound="gift" :disabled="openingGift !== null || buying !== null" @click="openGift(g)">
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
          <p v-else-if="pack.max_band" class="offer__note">Nothing above {{ BAND_LABEL[pack.max_band] }}, unless a pity guarantee is due.</p>
          <p class="offer__note offer__note--fine">Odds per card. A due pity guarantee overrides them. <NuxtLink to="/odds">How it works</NuxtLink></p>

          <div class="offer__foot">
            <button
              class="btn btn--gold offer__cta"
              :data-sound="confirming === pack.key || pack.price < CONFIRM_AT ? 'coin' : 'select'"
              :class="{ 'btn--off': !pack.canBuy }"
              type="button"
              :disabled="!pack.canBuy || buying !== null"
              @click="askOrBuy(pack)"
            >
              <template v-if="buying === pack.key">Opening</template>
              <template v-else-if="pack.remainingToday === 0">None left today</template>
              <template v-else-if="!pack.affordable">Need {{ (pack.price - (shop?.credits ?? 0)).toLocaleString('en') }} more</template>
              <template v-else-if="confirming === pack.key">Spend {{ pack.price.toLocaleString('en') }} credits</template>
              <template v-else>Buy · {{ pack.price.toLocaleString('en') }}</template>
            </button>
            <button v-if="confirming === pack.key && buying === null" class="btn btn--quiet offer__cancel" type="button" @click="confirming = null">Cancel</button>
            <p v-if="confirming === pack.key && buying === null" class="offer__note" role="status">
              You will have {{ ((shop?.credits ?? 0) - pack.price).toLocaleString('en') }} left.
            </p>
            <p v-else-if="pack.daily_limit" class="offer__note">{{ pack.remainingToday }} of {{ pack.daily_limit }} left today</p>
          </div>
        </div>
      </section>

      <!-- The other half of the economy, one tap away: this screen is where Credits are
           spent, so it is where the question "how do I get more" gets asked. -->
      <section class="offer offer--sponsors">
        <div class="offer__body">
          <h2 class="offer__name">Sponsors</h2>
          <p class="offer__blurb">
            A contract pays on every match you play, and pays more when the five you fielded
            met its terms. Two slots.
          </p>
          <NuxtLink class="btn btn--ghost offer__cta" to="/sponsors">Open the sponsor book</NuxtLink>
        </div>
      </section>

      <section class="earn" aria-labelledby="earn-title">
        <h2 id="earn-title" class="earn__title">Where Credits come from</h2>
        <ul class="earn__list">
          <li><b>Matches</b><span>Every match pays for playing, more for a win, more again for each starter graded S.</span></li>
          <li><b>Sponsors</b><span>A signed contract pays on every match, and pays more when your five meets its terms.</span></li>
          <li><b>Quests</b><span>Three dailies and three weeklies, collected from <NuxtLink to="/quests">Quests</NuxtLink>.</span></li>
          <li><b>Duplicates</b><span>A card you already hold turns into XP on it and Credits by rarity.</span></li>
        </ul>
        <p class="faint earn__foot"><NuxtLink to="/wallet">See every Credit in and out</NuxtLink></p>
      </section>
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
.offer__note--fine { font-size: 12px; }
.offer__note a, .earn a, .topbar__meta a { text-decoration: underline; text-underline-offset: 3px; }
.offer__cancel { margin-left: 4px; }
.topbar__meta { display: inline-flex; gap: 16px; }
.topbar__meta a { color: var(--ink-2); padding: 10px 0; }

.pitybar {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 16px;
  padding: 14px 18px;
  margin-bottom: 12px;
  background: var(--bg-1);
  border: 1px solid var(--line-1);
  border-radius: var(--radius);
}
.pitybar p { display: flex; justify-content: space-between; align-items: baseline; margin: 0 0 6px; font-size: 12px; color: var(--ink-3); }
.pitybar b { font-size: 13px; color: var(--ink-1); }
.pitybar__note { grid-column: 1 / -1; margin: 2px 0 0 !important; display: block !important; font-size: 12px; }

.earn { margin: 20px 0 8px; padding: 18px; border: 1px solid var(--line-1); border-radius: var(--radius); }
.earn__title { font-size: 17px; font-stretch: 92%; font-weight: 720; margin: 0 0 10px; }
.earn__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.earn__list li { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 12px; font-size: 13.5px; }
.earn__list b { font-weight: 680; }
.earn__list span { color: var(--ink-2); }
.earn__foot { margin: 12px 0 0; font-size: 13px; }
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

.opened { display: grid; gap: 16px; }
.opened__top { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.opened__head { font-size: 30px; margin: 2px 0 0; }
.opened__grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 16px; }
@media (min-width: 900px) { .opened__grid { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
.opened__slot { display: grid; align-content: start; }
.opened__face { display: grid; gap: 8px; animation: turn-in 300ms cubic-bezier(.2, .8, .25, 1.1) both; }
.opened__face[data-rarity="legendary"], .opened__face[data-rarity="icon"] { animation-duration: 460ms; }
@keyframes turn-in {
  0% { transform: perspective(900px) rotateY(-90deg) scale(.96); opacity: .4; }
  100% { transform: none; opacity: 1; }
}
.opened__dupe { margin: 0; font-size: 13px; color: var(--ink-2); text-align: center; }
.opened__new { margin: 0; text-align: center; }
.opened__actions { display: flex; flex-wrap: wrap; gap: 10px; }

/* the back of an unturned card: the pack's mark, glowing in the rarity it is hiding */
.facedown {
  --glow: var(--r-common);
  position: relative;
  width: 100%;
  aspect-ratio: 5 / 7;
  padding: 0;
  border: 1px solid var(--line-2);
  border-radius: 10px;
  background:
    radial-gradient(80% 60% at 50% 42%, color-mix(in srgb, var(--glow) 26%, transparent), transparent 70%),
    repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.03) 0 2px, transparent 2px 9px),
    linear-gradient(160deg, var(--bg-3), var(--bg-1));
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4) inset, 0 8px 24px rgba(0, 0, 0, 0.4);
  cursor: pointer;
  transition: transform 160ms, box-shadow 160ms, border-color 160ms;
  animation: deal 380ms cubic-bezier(.2, .8, .25, 1) both;
}
.opened__slot:nth-child(2) .facedown { animation-delay: 70ms; }
.opened__slot:nth-child(3) .facedown { animation-delay: 140ms; }
.opened__slot:nth-child(4) .facedown { animation-delay: 210ms; }
.opened__slot:nth-child(5) .facedown { animation-delay: 280ms; }
@keyframes deal { from { opacity: 0; transform: translateY(18px) scale(.94); } }
.facedown:hover { transform: translateY(-4px); border-color: color-mix(in srgb, var(--glow) 60%, var(--line-2)); }
.facedown:focus-visible { outline: 2px solid var(--gold-1); outline-offset: 3px; }
.facedown[data-rarity="rare"] { --glow: var(--r-rare); }
.facedown[data-rarity="epic"] { --glow: var(--r-epic); border-color: color-mix(in srgb, var(--r-epic) 45%, var(--line-2)); }
.facedown[data-rarity="legendary"] {
  --glow: var(--r-legendary);
  border-color: color-mix(in srgb, var(--r-legendary) 60%, var(--line-2));
  box-shadow: 0 0 28px color-mix(in srgb, var(--r-legendary) 30%, transparent), 0 8px 24px rgba(0, 0, 0, 0.4);
  animation: deal 380ms cubic-bezier(.2, .8, .25, 1) both, throb 1.6s 600ms ease-in-out infinite;
}
.facedown[data-rarity="icon"] {
  --glow: var(--r-icon);
  border-color: var(--r-icon);
  box-shadow: 0 0 34px color-mix(in srgb, var(--r-icon) 36%, transparent), 0 8px 24px rgba(0, 0, 0, 0.4);
  animation: deal 380ms cubic-bezier(.2, .8, .25, 1) both, throb 1.2s 600ms ease-in-out infinite;
}
@keyframes throb { 50% { transform: translateY(-3px) scale(1.015); } }
.facedown__mark {
  position: absolute;
  left: 50%;
  top: 44%;
  width: 30%;
  aspect-ratio: 1;
  transform: translate(-50%, -50%) rotate(45deg);
  border: 1.5px solid color-mix(in srgb, var(--glow) 70%, var(--ink-3));
}
.facedown__mark::after { content: ''; position: absolute; inset: 26%; background: color-mix(in srgb, var(--glow) 80%, var(--ink-2)); }
.facedown__word {
  position: absolute;
  left: 0;
  right: 0;
  top: 66%;
  text-align: center;
  font-stretch: 75%;
  font-weight: 880;
  font-size: 20px;
  letter-spacing: 0.2em;
  color: var(--ink-3);
}
@media (prefers-reduced-motion: reduce) {
  .facedown, .opened__face { animation: none !important; }
}


@media (min-width: 720px) {
  .offer { grid-template-columns: 140px minmax(0, 1fr); gap: 26px; padding: 22px; }
  .offer__foot { display: flex; align-items: center; gap: 16px; }
  .offer__foot .offer__note { margin: 0; }
}
</style>
