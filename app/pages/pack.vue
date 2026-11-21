<script setup lang="ts">
import { ROLES } from '~~/shared/roster';
import type { SoundName } from '~/composables/useSound';

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
 * Home.
 *
 * The pack is the hero because it is the one thing that is new every day. Under it, in the
 * order they matter: anything that needs you now (a room you are in, a challenge, a fixture
 * whose lobby is open, a gift), then your five, because the five is what every one of those
 * things is played with.
 */

const { packReady, packsWaiting, questsReady } = usePackSignal();
const { credits } = useWallet();
const focus = useFocusMode();
const { incoming: duelsIncoming, liveDuelId } = useDuelSignal();

// A gifted pack keeps saying so until it is opened: the toast in the layout is shown once,
// and this is the standing reminder. Opening happens in the shop, which is the one screen
// that can already reveal five cards at a time.
const { gifts } = useGiftSignal();
const gift = computed(() => gifts.value[0] ?? null);
const moreGifts = computed(() => Math.max(0, gifts.value.length - 1));

const status = ref<PackStatus | null>(null);
const loading = ref(true);
const opening = ref(false);
const error = ref('');

/** The pack just opened in this session, so the scene plays. */
const freshPull = ref<null | Pull>(null);
/** Counts the reveals in one sitting, so a run of banked packs reads "2 of 3". */
const run = ref({ index: 0, total: 0 });
const revealed = ref(false);

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
  if (!freshPull.value) run.value = { index: 0, total: status.value.waiting || 1 };
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

/** The reveal, voiced phase by phase; the stinger matches what came out. */
const PHASE_SOUND: Record<string, SoundName> = { charge: 'packCharge', tear: 'packTear', rise: 'cardRise', flip: 'cardFlip' };
/** The walkout: one beat per line of the card's identity, spaced like the animation. */
const WALK_MS: Record<string, number> = { LEGENDARY: 1800, ICON: 2700 };
let beatTimers: ReturnType<typeof setTimeout>[] = [];
function onPhase(phase: string) {
  const s = PHASE_SOUND[phase];
  if (s) playSound(s);
  if (phase === 'walkout') {
    const walk = WALK_MS[(freshPull.value?.card?.rarity || freshPull.value?.rarity || '').toUpperCase()] ?? 1800;
    beatTimers = [0.06, 0.28, 0.5, 0.72].map((f) => setTimeout(() => playSound('walkBeat'), walk * f));
  }
  if (phase === 'flip') { beatTimers.forEach(clearTimeout); beatTimers = []; }
}
function onRevealed() {
  revealed.value = true;
  playSound(revealSoundFor(freshPull.value?.rarity ?? freshPull.value?.card?.rarity));
  if (freshPull.value?.wasDuplicate) setTimeout(() => playSound('coin'), 700);
}

/**
 * Keep the card. With more packs banked, the next one opens straight away — that is the
 * whole point of coming back to three — and leaving the screen at any moment keeps the
 * rest waiting.
 */
async function keep() {
  const more = (freshPull.value?.waiting ?? 0) > 0;
  revealed.value = false;
  beatTimers.forEach(clearTimeout);
  beatTimers = [];
  if (more) {
    await open();
    if (freshPull.value) return;
  }
  freshPull.value = null;
  loading.value = true;
  await load();
}

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

const alreadyOpened = computed(() => !freshPull.value && !status.value?.available && status.value?.claim);

/**
 * When the next pack lands, in the viewer's own clock: "today at 18:00", "tomorrow at
 * 17:00". The pack day turns at a fixed hour in the league's timezone, so the word "today"
 * or "tomorrow" has to be worked out from the instant, never assumed.
 */
const viewerZone = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; }
})();

function localDayKey(d: Date) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

const nextLands = computed(() => {
  if (!status.value) return '';
  const at = new Date(status.value.nextOpensAt);
  const now = new Date(Date.now() + drift);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = localDayKey(at) === localDayKey(now)
    ? 'today'
    : localDayKey(at) === localDayKey(tomorrow)
      ? 'tomorrow'
      : at.toLocaleDateString([], { weekday: 'long' });
  return `${day} at ${time}`;
});

/** The league clock, only when it is not the viewer's own. */
const leagueClock = computed(() => {
  const s = status.value;
  if (!s || !viewerZone || viewerZone === s.timeZone) return '';
  const city = (s.timeZone.split('/').pop() || s.timeZone).replaceAll('_', ' ');
  return `${String(s.hour).padStart(2, '0')}:00 in ${city}`;
});

const streakLine = computed(() => {
  const st = status.value?.streak;
  if (!st) return '';
  const toGo = st.length - st.day;
  if (st.nextIsBonus) return `Day ${st.length} of ${st.length}: this pack is ${bandName(st.bonusFloor)} or better.`;
  if (st.openedToday) {
    return toGo === 0
      ? `Day ${st.length} of ${st.length} done. A new week of the streak starts tomorrow.`
      : `Day ${st.day} of ${st.length}. ${toGo === 1 ? 'Tomorrow' : `Day ${st.length}`}, the first pack is ${bandName(st.bonusFloor)} or better.`;
  }
  if (st.days > 0) return `Day ${st.day} of ${st.length} if you open today. Day ${st.length}'s pack is ${bandName(st.bonusFloor)} or better.`;
  return `Open a pack ${st.length} days in a row and the seventh is ${bandName(st.bonusFloor)} or better.`;
});

function bandName(b: string) {
  return b ? b.charAt(0) + b.slice(1).toLowerCase() : '';
}

/** Pity as a share of the way there, so the meter and the number agree. */
const legendaryShare = computed(() => {
  const p = status.value?.pity;
  if (!p) return 0;
  return Math.round((p.sinceLegendary / Math.max(1, p.sinceLegendary + p.legendaryIn)) * 100);
});
const iconShare = computed(() => {
  const p = status.value?.pity;
  if (!p) return 0;
  return Math.round((p.sinceIcon / Math.max(1, p.sinceIcon + p.iconIn)) * 100);
});

// --- the rest of the day -------------------------------------------------------

const roster = ref<any>(null);
const leagues = ref<any[]>([]);

async function loadAround() {
  const [r, l] = await Promise.allSettled([
    $fetch<any>('/api/roster'),
    $fetch<any>('/api/league/list'),
  ]);
  if (r.status === 'fulfilled') roster.value = r.value;
  if (l.status === 'fulfilled') leagues.value = l.value.leagues || [];
}

const five = computed(() => ROLES.map((role) => ({ role, card: roster.value?.roster?.[role]?.card ?? null })));
const fiveFilled = computed(() => five.value.filter((s) => s.card).length);
const fiveRating = computed(() => {
  const cards = five.value.filter((s) => s.card).map((s) => s.card.ovr as number);
  return cards.length ? (cards.reduce((a, b) => a + b, 0) / cards.length).toFixed(1) : null;
});

/** The soonest fixture across every league you are in. */
const fixture = computed(() => {
  const withNext = leagues.value.filter((l) => l.next);
  withNext.sort((a, b) => new Date(a.next.scheduledAt).getTime() - new Date(b.next.scheduledAt).getTime());
  return withNext[0] ?? null;
});

function kickOff(iso: string) {
  return new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

const hasMoves = computed(() => !!(liveDuelId.value || duelsIncoming.value || gift.value || fixture.value));

onMounted(() => {
  load();
  loadAround();
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
      :card="freshPull.card"
      :label="freshPull.streakBonus ? `Day ${status?.streak.length ?? 7}` : 'Daily'"
      auto-open
      @phase="onPhase"
      @revealed="onRevealed"
      @kept="keep"
    />
    <div v-if="revealed && (freshPull.wasDuplicate || freshPull.forcedBy || freshPull.streakBonus || run.total > 1)" class="reveal-page__notes" aria-live="polite">
      <p v-if="run.total > 1" class="reveal-page__note">
        Pack {{ run.index }} of {{ run.total }}<template v-if="freshPull.waiting">. Keep it to open the next.</template><template v-else>. That was the last one waiting.</template>
      </p>
      <p v-if="freshPull.forcedBy === 'icon-pity' || freshPull.forcedBy === 'legendary-pity'" class="reveal-page__note reveal-page__note--pity">
        <span class="gem" :class="freshPull.forcedBy === 'icon-pity' ? 'gem--icon' : 'gem--legendary'" aria-hidden="true" />
        {{ freshPull.forcedBy === 'icon-pity' ? 'Icon' : 'Legendary' }} guarantee paid out. The meter starts again.
      </p>
      <p v-else-if="freshPull.streakBonus" class="reveal-page__note reveal-page__note--pity">
        Day {{ status?.streak.length ?? 7 }} of your streak: {{ bandName(status?.streak.bonusFloor ?? 'EPIC') }} or better, as promised.
      </p>
      <p v-if="freshPull.wasDuplicate" class="reveal-page__note">
        Already yours. The copy became
        <template v-if="freshPull.xpAwarded"><strong>+{{ freshPull.xpAwarded }} XP</strong></template><template v-else>no XP (the card is at level 10)</template><template v-if="freshPull.creditsEarned"> and <strong class="reveal-page__credits">+{{ freshPull.creditsEarned }} credits</strong></template>.
      </p>
    </div>
  </main>

  <main v-else class="page page--full home">
    <p v-if="error" class="notice notice--bad" role="alert">{{ error }}</p>

    <div class="home__grid">
      <div class="home__main">
        <!-- first-run checklist slot: keep it directly above the daily pack hero -->

        <div v-if="loading" class="skeleton home__skeleton" />

        <!-- no cards loaded yet -->
        <section v-else-if="status && !status.catalogue" class="empty">
          <h2>The cards are not in yet</h2>
          <p>
            There is nothing to open until the player catalogue is loaded. Check back shortly.
          </p>
          <button class="btn btn--ghost" type="button" @click="load">Check again</button>
        </section>

        <!-- the pack -->
        <section v-else-if="status" class="hero" :class="{ 'is-ready': status.available }">
          <span class="hero__tl" aria-hidden="true" /><span class="hero__br" aria-hidden="true" />

          <div class="hero__art">
            <div v-if="alreadyOpened && status.claim?.card" class="hero__pull">
              <LomCard :card="status.claim.card" />
            </div>
            <div v-else class="pack" :class="{ 'pack--stack': status.waiting > 1 }" aria-hidden="true">
              <span class="pack__seal pack__seal--top" /><span class="pack__seal pack__seal--bottom" />
              <span class="pack__tear" />
              <span class="pack__mark">
                <svg viewBox="0 0 28 28"><path d="M14 2l12 12-12 12L2 14z" fill="none" stroke="currentColor" stroke-width="1.2" /><path d="M14 7.5L20.5 14 14 20.5 7.5 14z" fill="currentColor" /></svg>
              </span>
              <span class="pack__name"><small>LOM</small><b>{{ status.available && status.streak.nextIsBonus ? `Day ${status.streak.length}` : 'Daily' }}</b></span>
              <span class="pack__count">{{ status.waiting > 1 ? `${status.waiting} packs` : '1 player card' }}</span>
            </div>
          </div>

          <div class="hero__text">
            <template v-if="status.available">
              <p class="hero__state"><i aria-hidden="true" />{{ status.resume ? 'Not finished' : 'Ready to open' }}</p>
              <h1 class="hero__title">{{ status.waiting > 1 ? `${status.waiting} packs waiting` : status.todayWaiting ? "Today's pack" : 'A pack is waiting' }}</h1>
              <p class="hero__lede">
                <template v-if="status.resume">This pack was started and never finished. Nothing was lost: open it again to finish.</template>
                <template v-else-if="status.waiting > 1">One player card each, opened one after another. Unopened packs keep for three days.</template>
                <template v-else-if="!status.todayWaiting">Banked from an earlier day. One player card.</template>
                <template v-else>One player card from any season.</template>
                <template v-if="status.streak.nextIsBonus"> Day {{ status.streak.length }} of your streak: the first one is {{ bandName(status.streak.bonusFloor) }} or better.</template>
                <template v-if="status.todayWaiting || status.waiting > 1"> The next one lands {{ nextLands }}<template v-if="leagueClock"> ({{ leagueClock }})</template>.</template>
              </p>
              <button class="btn btn--lg hero__cta" type="button" data-sound="select" :disabled="opening" @click="open">
                {{ opening ? 'Opening' : status.resume ? 'Finish opening' : status.waiting > 1 ? `Open ${status.waiting} packs` : 'Open pack' }}
              </button>
            </template>

            <template v-else-if="alreadyOpened && status.claim">
              <p class="hero__state hero__state--quiet">Today's pull<template v-if="status.openedToday > 1"> · {{ status.openedToday }} packs opened today</template></p>
              <h1 v-if="status.claim.card" class="hero__title">{{ status.claim.card.playerName }} <span class="hero__year">{{ status.claim.card.season }}</span></h1>
              <h1 v-else class="hero__title">Pack opened</h1>
              <p v-if="!status.claim.card" class="hero__lede">The card is in your collection; it could not be shown here.</p>
              <p v-if="status.claim.wasDuplicate" class="hero__lede">
                A duplicate: it became
                <template v-if="status.claim.xpAwarded">+{{ status.claim.xpAwarded }} XP on the card you hold</template><template v-else>no XP (the card you hold is at level 10)</template><template v-if="status.claim.creditsAwarded"> and paid <span class="hero__credits">{{ status.claim.creditsAwarded }} credits</span></template>.
              </p>
              <p class="hero__next">Next pack in <b class="num">{{ remaining }}</b></p>
              <p class="faint hero__tz">Lands {{ nextLands }}<template v-if="leagueClock"> · {{ leagueClock }}</template></p>
            </template>

            <template v-else>
              <p class="hero__state hero__state--quiet">Daily pack</p>
              <h1 class="hero__title">Next pack</h1>
              <p class="hero__next"><b class="num">{{ remaining }}</b></p>
              <p class="faint hero__tz">Lands {{ nextLands }}<template v-if="leagueClock"> · {{ leagueClock }}</template></p>
            </template>

            <p v-if="streakLine" class="hero__streak">
              <span class="hero__streakdays" aria-hidden="true">
                <i v-for="n in status.streak.length" :key="n" :class="{ 'is-on': n < status.streak.day || (n === status.streak.day && status.streak.openedToday), 'is-seven': n === status.streak.length }" />
              </span>
              <span>{{ streakLine }}</span>
            </p>
          </div>

          <!-- pity, always visible: hidden pity is just anxiety -->
          <div class="pity">
            <div>
              <p><span>Legendary within</span><b class="tnum">{{ status.pity.legendaryIn }} {{ status.pity.legendaryIn === 1 ? 'card' : 'cards' }}</b></p>
              <div class="meter"><i :style="{ width: `${legendaryShare}%` }" /></div>
            </div>
            <div>
              <p><span>Icon within</span><b class="tnum">{{ status.pity.iconIn }} {{ status.pity.iconIn === 1 ? 'card' : 'cards' }}</b></p>
              <div class="meter meter--prism"><i :style="{ width: `${iconShare}%` }" /></div>
            </div>
            <NuxtLink class="pity__odds" to="/odds">How odds and pity work</NuxtLink>
          </div>
        </section>

        <!-- your five -->
        <section class="five">
          <div class="sect">
            <h2>Your five</h2>
            <NuxtLink class="sect__link" to="/roster">{{ fiveFilled < 5 ? 'Finish it' : 'Edit' }}</NuxtLink>
          </div>
          <div class="five__row">
            <NuxtLink v-for="s in five" :key="s.role" to="/roster" class="five__slot" :aria-label="`${s.role}: ${s.card ? `${s.card.playerName} ${s.card.season}` : 'empty'}`">
              <LomCard v-if="s.card" :card="s.card" compact :interactive="false" />
              <span v-else class="five__hole">+</span>
              <span class="five__role">{{ s.role }}</span>
            </NuxtLink>
          </div>
          <p v-if="fiveRating" class="five__sum">
            <span>Rating <b class="tnum">{{ fiveRating }}</b></span>
            <span>{{ fiveFilled }} of 5 set</span>
          </p>
        </section>
      </div>

      <aside class="home__side">
        <section>
          <div class="sect"><h2>Your move</h2></div>

          <ul v-if="hasMoves" class="moves">
            <li v-if="liveDuelId" class="move">
              <span class="move__mark move__mark--live" aria-hidden="true" />
              <p class="move__t">You are in a live room<span class="move__s">Somebody is on the other side of it</span></p>
              <NuxtLink class="btn btn--ghost btn--sm" :to="`/duel/${liveDuelId}`">Rejoin</NuxtLink>
            </li>
            <li v-if="duelsIncoming" class="move">
              <span class="move__mark" aria-hidden="true">{{ duelsIncoming }}</span>
              <p class="move__t">{{ duelsIncoming === 1 ? 'A challenge is waiting' : `${duelsIncoming} challenges waiting` }}<span class="move__s">Somebody wants to draft against you</span></p>
              <NuxtLink class="btn btn--ghost btn--sm" to="/duels">Answer</NuxtLink>
            </li>
            <li v-if="fixture" class="move">
              <span class="move__mark" aria-hidden="true">D{{ fixture.next.dayIndex }}</span>
              <p class="move__t">vs {{ fixture.next.opponent }}<span class="move__s">{{ fixture.name }} · {{ kickOff(fixture.next.scheduledAt) }}</span></p>
              <NuxtLink class="btn btn--ghost btn--sm" :to="`/leagues/${fixture.id}`">{{ fixture.next.playable ? 'Play' : 'View' }}</NuxtLink>
            </li>
            <li v-if="gift" class="move">
              <span class="move__mark move__mark--gift" aria-hidden="true">Gift</span>
              <p class="move__t">{{ gift.title }}<span class="move__s">{{ gift.packName }}, free<template v-if="moreGifts"> · {{ moreGifts }} more after it</template></span></p>
              <NuxtLink class="btn btn--ghost btn--sm" to="/shop">Open</NuxtLink>
            </li>
          </ul>

          <div v-else class="calm">
            <p>Nothing is waiting on you.</p>
            <NuxtLink class="btn btn--ghost btn--block" to="/duels">Find a battle</NuxtLink>
          </div>
        </section>

        <section v-if="status && status.quests.dailyTotal">
          <div class="sect"><h2>Quests</h2><NuxtLink class="sect__link" to="/quests">All quests</NuxtLink></div>
          <NuxtLink class="shopline questline" to="/quests">
            <span>
              <b>{{ status.quests.dailyDone }} of {{ status.quests.dailyTotal }} dailies done</b>
              <span class="faint">{{ status.quests.claimable ? `${status.quests.claimable} ready to collect` : 'Credits for playing the way you already play' }}</span>
            </span>
            <span class="questline__pips" aria-hidden="true">
              <i v-for="n in status.quests.dailyTotal" :key="n" :class="{ 'is-on': n <= status.quests.dailyDone }" />
            </span>
          </NuxtLink>
        </section>

        <section>
          <div class="sect"><h2>Shop</h2><NuxtLink class="sect__link" to="/shop">All packs</NuxtLink></div>
          <NuxtLink class="shopline" to="/shop">
            <span><b>More packs</b><span class="faint">Squad packs, and better odds for a price</span></span>
            <span class="credits"><i class="coin" aria-hidden="true" />{{ (status?.credits ?? credits ?? 0).toLocaleString('en') }}</span>
          </NuxtLink>
          <p class="shoplinks">
            <NuxtLink to="/wallet">Wallet and history</NuxtLink>
            <NuxtLink to="/odds">Odds and pity</NuxtLink>
          </p>
        </section>
      </aside>
    </div>
  </main>
</template>

<style scoped>
.home { padding-top: 14px; }
.home__grid { display: grid; gap: 28px; }
.home__skeleton { height: 360px; }

/* --- the pack hero ---------------------------------------------------------- */
.hero {
  position: relative;
  display: grid;
  grid-template-columns: minmax(104px, 34%) minmax(0, 1fr);
  grid-template-areas: "art text" "pity pity";
  gap: 18px;
  align-items: center;
  padding: 18px;
  background: linear-gradient(165deg, #121b2d, #0a0f19 70%);
  border: 1px solid var(--line-1);
  border-radius: var(--radius);
}
.hero__tl, .hero__br { position: absolute; width: 14px; height: 14px; border: 1.5px solid var(--gold-2); pointer-events: none; }
.hero__tl { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
.hero__br { right: -1px; bottom: -1px; border-left: 0; border-top: 0; }

.hero__art { container-type: inline-size; }
.hero__pull { width: 100%; }

.hero__state { display: inline-flex; align-items: center; gap: 7px; margin: 0; font-size: 13px; font-weight: 650; color: var(--teal-1); }
.hero__state i { width: 7px; height: 7px; background: var(--teal-2); transform: rotate(45deg); }
.hero__state--quiet { color: var(--ink-3); }
.hero__title { margin: 8px 0 6px; font-size: clamp(26px, 7vw, 56px); line-height: 0.92; font-weight: 850; font-stretch: 76%; }
.hero__year { color: var(--gold-1); }
.hero__lede { margin: 0 0 16px; font-size: 13.5px; color: var(--ink-2); max-width: 40ch; }
.hero__cta { width: 100%; }
.hero__next { margin: 6px 0 0; font-size: 13.5px; color: var(--ink-2); }
.hero__next .num { display: block; font-size: 40px; color: var(--ink-1); margin-top: 4px; }
.hero__tz { margin: 4px 0 0; font-size: 12px; }
.hero__credits { color: var(--gold-1); font-weight: 650; }
.hero__streak { display: flex; align-items: center; gap: 10px; margin: 14px 0 0; font-size: 12.5px; color: var(--ink-3); }
.hero__streakdays { display: inline-flex; gap: 4px; flex: none; }
.hero__streakdays i { width: 8px; height: 8px; transform: rotate(45deg); box-shadow: inset 0 0 0 1px var(--line-3); }
.hero__streakdays i.is-seven { box-shadow: inset 0 0 0 1px var(--gold-2); }
.hero__streakdays i.is-on { background: var(--gold-2); box-shadow: none; }

.hero__art { grid-area: art; }
.hero__text { grid-area: text; }
.pity { grid-area: pity; display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding-top: 16px; margin-top: 2px; border-top: 1px solid var(--line-1); }
.pity p { display: flex; justify-content: space-between; align-items: baseline; margin: 0 0 6px; font-size: 12px; color: var(--ink-3); }
.pity b { font-size: 13px; color: var(--ink-1); }
.pity__odds { grid-column: 1 / -1; justify-self: start; font-size: 12px; color: var(--ink-3); text-decoration: underline; text-underline-offset: 3px; padding: 6px 0; }
.pity__odds:hover { color: var(--ink-1); }

/* the pack, drawn: foil stock, crimped seals, the mark */
.pack {
  position: relative;
  width: 100%;
  aspect-ratio: 5 / 8;
  font-size: 5cqw;
  overflow: hidden;
  background: radial-gradient(120% 70% at 50% 36%, rgba(216, 176, 100, 0.2), transparent 62%), linear-gradient(165deg, #26365a 0%, #0a101c 80%);
  filter: drop-shadow(0 1.2em 1.2em rgba(0, 0, 0, 0.55));
}
/* More than one waiting: the packs behind show as edges. */
.pack--stack { box-shadow: 0.5em -0.5em 0 -0.1em #1b2740, 1em -1em 0 -0.2em #121b2d; overflow: visible; }
.pack::after { content: ''; position: absolute; inset: 0; background: linear-gradient(115deg, transparent 30%, rgba(255, 255, 255, 0.14) 42%, rgba(255, 255, 255, 0.03) 50%, transparent 58%); }
.pack__seal { position: absolute; left: 0; right: 0; height: 8%; background: repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.15) 0 1px, transparent 1px 4px), linear-gradient(180deg, #34456a, #0a101c); }
.pack__seal--top { top: 0; }
.pack__seal--bottom { bottom: 0; transform: scaleY(-1); }
.pack__tear { position: absolute; left: 6%; right: 6%; top: 11.5%; border-top: 1px dashed rgba(245, 223, 168, 0.4); }
.pack__mark { position: absolute; left: 50%; top: 31%; width: 34%; aspect-ratio: 1; transform: translate(-50%, -50%); color: var(--gold-2); }
.pack__mark svg { width: 100%; height: 100%; }
.pack__name { position: absolute; left: 0; right: 0; top: 52%; text-align: center; color: var(--gold-1); }
.pack__name small { display: block; font-stretch: 125%; font-size: 0.62em; font-weight: 720; letter-spacing: 0.32em; opacity: 0.8; }
.pack__name b { display: block; margin-top: 0.2em; font-stretch: 75%; font-size: 2.4em; font-weight: 860; line-height: 0.9; text-transform: uppercase; }
.pack__count { position: absolute; left: 50%; bottom: 13%; transform: translateX(-50%); padding: 0.35em 0.9em; border: 1px solid rgba(216, 176, 100, 0.55); font-stretch: 118%; font-size: 0.6em; font-weight: 760; letter-spacing: 0.2em; text-transform: uppercase; color: var(--gold-1); white-space: nowrap; }

/* --- sections ------------------------------------------------------------- */
.sect { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.sect h2 { font-stretch: 92%; font-weight: 720; font-size: 17px; }
.sect__link { font-size: 13px; font-weight: 600; color: var(--ink-2); }
.sect__link:hover { color: var(--ink-1); }

.five { margin-top: 24px; }
.five__row { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
.five__slot { display: grid; gap: 6px; }
.five__hole { display: grid; place-items: center; aspect-ratio: 63 / 88; border: 1px dashed var(--line-3); border-radius: 4%; font-size: 22px; color: var(--ink-3); }
.five__role { text-align: center; font-stretch: 112%; font-size: 10.5px; font-weight: 720; letter-spacing: 0.12em; color: var(--ink-3); }
.five__sum { display: flex; gap: 18px; margin: 12px 0 0; font-size: 12.5px; color: var(--ink-3); }
.five__sum b { color: var(--ink-1); font-weight: 700; }

.moves { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line-1); }
.move { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 11px 0; border-bottom: 1px solid var(--line-1); }
.move__mark {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--bg-3);
  box-shadow: inset 0 0 0 1px var(--line-2);
  font-stretch: 85%;
  font-size: 13px;
  font-weight: 800;
  color: var(--ink-1);
}
.move__mark--live { background: var(--teal-2); box-shadow: none; }
.move__mark--gift { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--gold-1); box-shadow: inset 0 0 0 1px rgba(216, 176, 100, 0.5); }
.move__t { margin: 0; font-size: 14.5px; font-weight: 620; line-height: 1.25; }
.move__s { display: block; margin-top: 3px; font-size: 12.5px; font-weight: 500; color: var(--ink-3); }

.calm { padding: 18px 0 0; border-top: 1px solid var(--line-1); }
.calm p { margin: 0 0 12px; color: var(--ink-3); font-size: 14px; }

.home__side { display: grid; gap: 28px; align-content: start; }
.shopline { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; background: var(--bg-2); border: 1px solid var(--line-1); border-radius: var(--radius); }
.shopline b { display: block; font-weight: 680; }
.shopline .faint { display: block; font-size: 12.5px; margin-top: 2px; }
.questline__pips { display: inline-flex; gap: 6px; flex: none; }
.questline__pips i { width: 10px; height: 10px; transform: rotate(45deg); box-shadow: inset 0 0 0 1px var(--line-3); }
.questline__pips i.is-on { background: var(--gold-2); box-shadow: none; }
.shoplinks { display: flex; flex-wrap: wrap; gap: 4px 18px; margin: 8px 0 0; font-size: 13px; }
.shoplinks a { color: var(--ink-3); padding: 10px 0; }
.shoplinks a:hover { color: var(--ink-1); }

.empty code { font-family: ui-monospace, monospace; font-size: 0.86em; padding: 0.12em 0.4em; border-radius: 2px; background: var(--bg-3); color: var(--ink-1); }

/* --- the reveal ------------------------------------------------------------- */
.reveal-page {
  position: relative;
  min-height: 100svh;
  background: radial-gradient(70% 55% at 50% 44%, #101a2c, var(--bg-0) 78%);
}
.reveal-page__notes {
  position: absolute;
  left: 16px;
  right: 16px;
  top: max(16px, env(safe-area-inset-top));
  display: grid;
  gap: 6px;
  justify-items: center;
  pointer-events: none;
  z-index: 3;
}
.reveal-page__note {
  margin: 0;
  max-width: 440px;
  padding: 9px 14px;
  font-size: 14px;
  line-height: 1.4;
  text-align: center;
  color: var(--ink-1);
  background: rgba(10, 15, 27, 0.86);
  border: 1px solid var(--line-2);
  border-radius: 4px;
  backdrop-filter: blur(6px);
  animation: note-in 360ms 500ms cubic-bezier(.2, .8, .2, 1) both;
}
.reveal-page__note--pity { display: inline-flex; align-items: center; gap: 8px; border-color: rgba(216, 178, 104, 0.5); color: var(--gold-1); }
.reveal-page__credits { color: var(--gold-1); }
/* Landscape: the card fills the height, so the notes sit beside it instead of over it. */
@media (min-aspect-ratio: 1/1) and (min-width: 700px) {
  .reveal-page__notes { right: auto; top: 50%; transform: translateY(-50%); width: min(26vw, 320px); justify-items: stretch; }
  .reveal-page__note { text-align: left; }
}
@keyframes note-in { from { opacity: 0; transform: translateY(-8px); } }
@media (prefers-reduced-motion: reduce) { .reveal-page__note { animation: none; } }

@media (min-width: 720px) {
  .hero { grid-template-columns: 220px minmax(0, 1fr); grid-template-areas: "art text" "art pity"; gap: 24px 36px; padding: 32px 36px; }
  .pity { border-top: 0; padding-top: 0; align-self: start; }
}
@media (min-width: 1024px) {
  .home__grid { grid-template-columns: minmax(0, 7fr) minmax(320px, 4fr); gap: 36px; }
  .hero { grid-template-columns: 250px minmax(0, 1fr); gap: 44px; padding: 40px 44px; }
  .hero__cta { width: auto; min-width: 220px; }
  .five__row { gap: 14px; }
}
</style>
