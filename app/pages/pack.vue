<script setup lang="ts">
import { COVER_SIZE } from '@lom/card-engine';

interface Pull {
  rarity: string | null;
  wasDuplicate: boolean;
  xpAwarded: number;
  creditsAwarded?: number;
  creditsEarned?: number;
  forcedBy?: string | null;
  streakBonus?: boolean;
  waiting?: number;
  card: any;
}

interface PackStatus {
  packDay: string;
  nextOpensAt: string;
  serverNow: string;
  hour: number;
  timeZone: string;
  available: boolean;
  waiting: number;
  bankMax: number;
  todayWaiting: boolean;
  resume: boolean;
  openedToday: number;
  catalogue: string | null;
  credits: number;
  claim: null | Pull;
  streak: { days: number; openedToday: boolean; day: number; length: number; nextIsBonus: boolean; bonusFloor: string };
  pity: { sinceLegendary: number; sinceIcon: number; packsOpened: number; legendaryIn: number; iconIn: number };
  quests: { dailyDone: number; dailyTotal: number; claimable: number };
  collectionCount: number;
}

/**
 * Home is the daily pack and the way to the shop, on one screen that never scrolls.
 * Everything else has a tab of its own.
 */

const { packReady, packsWaiting, questsReady } = usePackSignal();
const { credits } = useWallet();
const focus = useFocusMode();
const { gifts } = useGiftSignal();

const status = ref<PackStatus | null>(null);
const loading = ref(true);
const opening = ref(false);
const error = ref('');

/** The pack just opened in this session, so the scene plays. */
const freshPull = ref<null | Pull>(null);
/** Counts the reveals in one sitting, so a run of banked packs reads "2 of 3". */
const run = ref({ index: 0, total: 0 });
const revealed = ref(false);
/** Where the pack is on screen, so the opening lifts it from there. */
const from = ref<null | { cx: number; cy: number; w: number }>(null);
const packEl = ref<HTMLElement | null>(null);

async function load() {
  try {
    status.value = await $fetch<PackStatus>('/api/pack/status');
    packReady.value = status.value.available;
    packsWaiting.value = status.value.waiting ?? 0;
    questsReady.value = status.value.quests?.claimable ?? 0;
    credits.value = status.value.credits;
    // Server time wins; a phone with a wrong clock should still see the right countdown.
    drift = new Date(status.value.serverNow).getTime() - Date.now();
    tick();
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'Could not reach the server.';
  } finally {
    loading.value = false;
  }
}

async function open() {
  if (!status.value?.available || opening.value) return;
  opening.value = true;
  error.value = '';
  if (!freshPull.value) {
    run.value = { index: 0, total: status.value.waiting || 1 };
    const box = packEl.value?.getBoundingClientRect();
    from.value = box ? { cx: box.left + box.width / 2, cy: box.top + box.height / 2, w: box.width * COVER_SIZE.packShare } : null;
  } else {
    from.value = null;
  }
  try {
    const result = await $fetch<any>('/api/pack/claim', { method: 'POST' });
    run.value = { index: run.value.index + 1, total: Math.max(run.value.total, run.value.index + 1 + (result.waiting ?? 0)) };
    freshPull.value = result;
    credits.value = result.credits;
    packsWaiting.value = result.waiting ?? 0;
    packReady.value = (result.waiting ?? 0) > 0;
    if (status.value) status.value = { ...status.value, waiting: result.waiting ?? 0, available: (result.waiting ?? 0) > 0 };
  } catch (e: any) {
    freshPull.value = null;
    error.value = e?.data?.statusMessage || e?.message || 'The pack did not open. Try again.';
    await load();
  } finally {
    opening.value = false;
  }
}

/** The reveal owns the screen until the card is kept. */
watch(freshPull, (pull) => { focus.value = !!pull; });
onBeforeUnmount(() => { focus.value = false; });

function onRevealed() {
  revealed.value = true;
  if (freshPull.value?.wasDuplicate && freshPull.value.creditsEarned) setTimeout(() => playSound('coin'), 700);
}

/**
 * Keep the card. With more packs banked, the next one opens straight away — that is the
 * whole point of coming back to three — and leaving the screen at any moment keeps the
 * rest waiting.
 */
async function keep() {
  const more = (freshPull.value?.waiting ?? 0) > 0;
  revealed.value = false;
  if (more) {
    await open();
    if (freshPull.value) return;
  }
  freshPull.value = null;
  await load();
}

const keepLabel = computed(() => ((freshPull.value?.waiting ?? 0) > 0 ? 'Keep and open next' : 'Add to collection'));

// --- countdown ---------------------------------------------------------------

let drift = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const remaining = ref('');

/**
 * The status is re-read when the countdown runs out, but not once a second: the server's
 * clock and ours can disagree by a moment, and a pack that is not quite ready yet must not
 * turn into a request every tick. One read in flight at a time, then a growing pause.
 */
let reloading = false;
let retryAt = 0;
let retryGap = 2000;

async function reloadWhenDue() {
  if (reloading || Date.now() < retryAt) return;
  reloading = true;
  try {
    await load();
  } finally {
    reloading = false;
    retryAt = Date.now() + retryGap;
    retryGap = Math.min(retryGap * 2, 60000);
  }
}

function tick() {
  if (!status.value) return;
  const ms = new Date(status.value.nextOpensAt).getTime() - (Date.now() + drift);
  if (ms <= 0) {
    remaining.value = '00:00:00';
    if (!status.value.available) reloadWhenDue();
    else retryGap = 2000;
    return;
  }
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  remaining.value = `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

const pulled = computed(() => (!status.value?.available ? status.value?.claim?.card ?? null : null));

const title = computed(() => {
  const s = status.value;
  if (!s) return '';
  if (s.available) return s.waiting > 1 ? `${s.waiting} packs waiting` : s.todayWaiting ? 'Today’s pack' : 'A pack is waiting';
  return s.claim ? 'Pack opened' : 'Next pack';
});

const streakDays = computed(() => {
  const st = status.value?.streak;
  if (!st) return [];
  return Array.from({ length: st.length }, (_, i) => {
    const n = i + 1;
    return { n, on: n < st.day || (n === st.day && st.openedToday), last: n === st.length };
  });
});
const streakText = computed(() => {
  const st = status.value?.streak;
  if (!st) return '';
  if (st.nextIsBonus) return `Day ${st.length}: ${st.bonusFloor.charAt(0)}${st.bonusFloor.slice(1).toLowerCase()} or better`;
  return `Day ${Math.max(1, st.day)} of ${st.length}`;
});

onMounted(() => {
  preloadPackSounds();
  load();
  timer = setInterval(tick, 1000);
});
onBeforeUnmount(() => clearInterval(timer));

useHead({ title: 'Home — LOM' });
</script>

<template>
  <!-- just opened: the reveal owns the screen -->
  <main v-if="freshPull" class="reveal-page">
    <PackScene
      :key="run.index"
      :cards="freshPull.card"
      pack-type="DAILY"
      :from="from"
      :keep-label="keepLabel"
      @revealed="onRevealed"
      @kept="keep"
    />
    <div v-if="revealed && (freshPull.wasDuplicate || freshPull.forcedBy || freshPull.streakBonus || run.total > 1)" class="reveal-page__notes" aria-live="polite">
      <p v-if="run.total > 1" class="reveal-page__note">Pack {{ run.index }} of {{ run.total }}</p>
      <p v-if="freshPull.forcedBy === 'icon-pity' || freshPull.forcedBy === 'legendary-pity'" class="reveal-page__note reveal-page__note--pity">
        <span class="gem" :class="freshPull.forcedBy === 'icon-pity' ? 'gem--icon' : 'gem--legendary'" aria-hidden="true" />
        {{ freshPull.forcedBy === 'icon-pity' ? 'Icon' : 'Legendary' }} guarantee paid out. The meter starts again.
      </p>
      <p v-else-if="freshPull.streakBonus" class="reveal-page__note reveal-page__note--pity">
        Day {{ status?.streak.length ?? 7 }} of your streak: {{ status?.streak.bonusFloor === 'EPIC' ? 'Epic' : status?.streak.bonusFloor }} or better, as promised.
      </p>
      <p v-if="freshPull.wasDuplicate" class="reveal-page__note">
        Already yours:
        <template v-if="freshPull.xpAwarded"><strong>+{{ freshPull.xpAwarded }} XP</strong></template><template v-else>the card is at level 10</template><template v-if="freshPull.creditsEarned">, <strong class="reveal-page__credits">+{{ freshPull.creditsEarned }} credits</strong></template>
      </p>
    </div>
  </main>

  <main v-else class="page--screen daily" :class="{ 'has-stack': (status?.waiting ?? 0) > 1 }">
    <p v-if="error" class="notice notice--bad daily__error" role="alert">{{ error }}</p>

    <section class="daily__panel" aria-label="Daily pack">
      <span class="hero__tl" aria-hidden="true" /><span class="hero__br" aria-hidden="true" />

      <div v-if="loading" class="skeleton daily__skeleton" />

      <div v-else-if="status && !status.catalogue" class="empty daily__empty">
        <h2>The cards are not in yet</h2>
        <p>There is nothing to open until the player catalogue is loaded. Check back shortly.</p>
        <button class="btn btn--ghost" type="button" @click="load">Check again</button>
      </div>

      <template v-else-if="status">
        <div class="daily__art">
          <div v-if="pulled" class="daily__pull"><LomCard :card="pulled" /></div>
          <button
            v-else ref="packEl" class="daily__pack" type="button" data-sound="select"
            :disabled="!status.available || opening"
            :aria-label="status.available ? 'Open your daily pack' : 'Your next pack is on its way'"
            @click="open"
          >
            <span v-if="status.waiting > 2" class="daily__back daily__back--2"><PackCover kind="DAILY" /></span>
            <span v-if="status.waiting > 1" class="daily__back daily__back--1"><PackCover kind="DAILY" /></span>
            <PackCover kind="DAILY" />
          </button>
        </div>

        <div class="daily__text">
          <p class="hero__state" :class="{ 'hero__state--quiet': !status.available }">
            <i aria-hidden="true" />{{ status.available ? (status.resume ? 'Not finished' : 'Ready to open') : pulled ? 'Today’s pull' : 'Daily pack' }}
          </p>
          <h1 class="hero__title">
            <template v-if="pulled">{{ pulled.playerName }} <span class="hero__year">{{ pulled.season }}</span></template>
            <template v-else>{{ title }}</template>
          </h1>
          <p class="hero__streak">
            <span class="hero__streakdays" aria-hidden="true">
              <i v-for="d in streakDays" :key="d.n" :class="{ 'is-on': d.on, 'is-seven': d.last }" />
            </span>
            <span>{{ streakText }}</span>
          </p>
          <button v-if="status.available" class="btn btn--lg daily__open" type="button" data-sound="select" :disabled="opening" @click="open">
            {{ opening ? 'Opening' : status.resume ? 'Finish opening' : status.waiting > 1 ? `Open ${status.waiting} packs` : 'Open pack' }}
          </button>
          <p v-else class="hero__next">Next pack in <b class="num">{{ remaining }}</b></p>
        </div>
      </template>
    </section>

    <NuxtLink class="btn btn--gold btn--lg daily__shop" to="/shop">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l-1.2 12H6.2zM9 8V6a3 3 0 0 1 6 0v2" /></svg>
      Shop
      <span v-if="gifts.length" class="daily__gifts">{{ gifts.length === 1 ? '1 gift' : `${gifts.length} gifts` }}</span>
    </NuxtLink>
  </main>
</template>

<style scoped>
.daily { display: grid; grid-template-rows: minmax(0, 1fr) auto; gap: 10px; width: min(100%, 500px); margin-inline: auto; padding: 10px 14px 0; }
.daily__error { position: absolute; z-index: 5; left: 14px; right: 14px; margin: 0; }
.daily__panel { position: relative; min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr) auto; gap: 12px; padding: 16px; background: linear-gradient(165deg, #121b2d, #0a0f19 70%); border: 1px solid var(--line-1); border-radius: var(--radius); }
.daily__skeleton { grid-row: 1 / -1; }
.daily__empty { grid-row: 1 / -1; align-self: center; border: 0; }
.hero__tl, .hero__br { position: absolute; width: 14px; height: 14px; border: 1.5px solid var(--gold-2); pointer-events: none; }
.hero__tl { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
.hero__br { right: -1px; bottom: -1px; border-left: 0; border-top: 0; }

.daily__art { position: relative; min-height: 0; }
.daily__pack { position: absolute; left: 50%; top: 50%; height: 100%; max-width: 100%; aspect-ratio: 580 / 850; padding: 0; border: 0; background: none; transform: translate(-50%, -50%); cursor: pointer; transition: transform 160ms var(--ease-out); }
.daily__pack:active:not(:disabled) { transform: translate(-50%, -50%) scale(0.985); }
.daily__pack:disabled { cursor: default; filter: brightness(0.6); }
.daily__pack :deep(canvas) { position: absolute; inset: 0; }
.daily__back { position: absolute; inset: 0; }
.daily__back--1 { transform: translate(9%, -1.5%) rotate(4deg) scale(0.96); filter: brightness(0.62); }
.daily__back--2 { transform: translate(-9%, -1.5%) rotate(-4deg) scale(0.94); filter: brightness(0.45); }
.daily__pull { position: absolute; left: 50%; top: 50%; height: 100%; max-width: 100%; aspect-ratio: 63 / 88; transform: translate(-50%, -50%); display: grid; place-items: center; }

.daily__text { display: grid; justify-items: center; gap: 5px; text-align: center; }
.hero__state { display: inline-flex; align-items: center; gap: 7px; margin: 0; font-size: 13px; font-weight: 650; color: var(--teal-1); }
.hero__state i { width: 7px; height: 7px; background: var(--teal-2); transform: rotate(45deg); }
.hero__state--quiet { color: var(--ink-3); }
.hero__state--quiet i { background: var(--ink-3); }
.hero__title { margin: 0; font-size: clamp(27px, 8vw, 38px); line-height: 0.95; font-weight: 850; font-stretch: 76%; }
.hero__year { color: var(--gold-1); }
.hero__next { margin: 0; font-size: 13px; color: var(--ink-2); }
.hero__next .num { margin-left: 6px; font-size: 19px; color: var(--ink-1); }
.hero__streak { display: flex; align-items: center; justify-content: center; gap: 9px; margin: 1px 0 3px; font-size: 12.5px; color: var(--ink-3); }
.hero__streakdays { display: inline-flex; gap: 5px; flex: none; }
.hero__streakdays i { width: 8px; height: 8px; transform: rotate(45deg); box-shadow: inset 0 0 0 1px var(--line-3); }
.hero__streakdays i.is-seven { box-shadow: inset 0 0 0 1px var(--gold-2); }
.hero__streakdays i.is-on { background: var(--gold-2); box-shadow: none; }
.daily__open, .daily__shop { width: 100%; }
.daily__shop svg { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.daily__gifts { padding: 2px 7px; background: var(--gold-ink); color: var(--gold-1); font-size: 10.5px; letter-spacing: 0.08em; }

/* --- the reveal ------------------------------------------------------------- */
.reveal-page { position: relative; min-height: 100svh; }
.reveal-page__notes {
  position: fixed;
  left: 16px;
  right: 16px;
  top: max(16px, env(safe-area-inset-top));
  display: grid;
  gap: 6px;
  justify-items: center;
  pointer-events: none;
  z-index: 70;
}
.reveal-page__note {
  margin: 0;
  max-width: 440px;
  padding: 8px 13px;
  font-size: 13.5px;
  line-height: 1.35;
  text-align: center;
  color: var(--ink-1);
  background: rgba(10, 15, 27, 0.86);
  border: 1px solid var(--line-2);
  border-radius: var(--radius);
  animation: note-in 360ms 500ms cubic-bezier(.2, .8, .2, 1) both;
}
.reveal-page__note--pity { display: inline-flex; align-items: center; gap: 8px; border-color: rgba(216, 178, 104, 0.5); color: var(--gold-1); }
.reveal-page__credits { color: var(--gold-1); }
@keyframes note-in { from { opacity: 0; transform: translateY(-8px); } }

@media (max-height: 640px) {
  .daily { gap: 8px; padding: 7px 12px 0; }
  .daily__panel { gap: 8px; padding: 10px 12px 12px; }
  .daily__text { gap: 3px; }
  .hero__title { font-size: 25px; }
  .daily__open, .daily__shop { min-height: 46px; }
}
@media (min-width: 1024px) { .daily { padding-top: 16px; } }
@media (prefers-reduced-motion: reduce) { .reveal-page__note { animation: none; } }
</style>
