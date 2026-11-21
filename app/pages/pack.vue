<script setup lang="ts">
import { ROLES } from '~~/shared/roster';
import type { SoundName } from '~/composables/useSound';

interface PackStatus {
  packDay: string;
  nextOpensAt: string;
  serverNow: string;
  hour: number;
  timeZone: string;
  available: boolean;
  catalogue: string | null;
  credits: number;
  claim: null | { rarity: string; wasDuplicate: boolean; xpAwarded: number; card: any };
  pity: { sinceLegendary: number; sinceIcon: number; packsOpened: number; legendaryIn: number; iconIn: number };
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

const { packReady } = usePackSignal();
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
const freshPull = ref<null | { rarity: string; wasDuplicate: boolean; xpAwarded: number; card: any }>(null);
const revealed = ref(false);

async function load() {
  try {
    status.value = await $fetch<PackStatus>('/api/pack/status');
    packReady.value = status.value.available;
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
  try {
    const result = await $fetch<any>('/api/pack/claim', { method: 'POST' });
    freshPull.value = result;
    packReady.value = false;
  } catch (e: any) {
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
function onPhase(phase: string) {
  const s = PHASE_SOUND[phase];
  if (s) playSound(s);
}
function onRevealed() {
  revealed.value = true;
  playSound(revealSoundFor(freshPull.value?.rarity ?? freshPull.value?.card?.rarity));
  if (freshPull.value?.wasDuplicate) setTimeout(() => playSound('coin'), 700);
}

async function keep() {
  freshPull.value = null;
  revealed.value = false;
  loading.value = true;
  await load();
}

// --- countdown ---------------------------------------------------------------

let drift = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const remaining = ref('');

function tick() {
  if (!status.value) return;
  const ms = new Date(status.value.nextOpensAt).getTime() - (Date.now() + drift);
  if (ms <= 0) {
    remaining.value = '00:00:00';
    if (!status.value.available) load();
    return;
  }
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  remaining.value = `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

const alreadyOpened = computed(() => !freshPull.value && status.value?.claim);

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
      :card="freshPull.card"
      label="Daily"
      auto-open
      @phase="onPhase"
      @revealed="onRevealed"
      @kept="keep"
    />
    <p v-if="revealed && freshPull.wasDuplicate" class="notice reveal-page__dupe">
      You already had {{ freshPull.card.playerName }} {{ freshPull.card.season }}. The copy became
      <strong>+{{ freshPull.xpAwarded }} XP</strong> on the card you hold.
    </p>
  </main>

  <main v-else class="page page--full home">
    <p v-if="error" class="notice notice--bad">{{ error }}</p>

    <div class="home__grid">
      <div class="home__main">
        <div v-if="loading" class="skeleton home__skeleton" />

        <!-- no cards loaded yet -->
        <section v-else-if="status && !status.catalogue" class="empty">
          <h2>No catalogue loaded</h2>
          <p>
            There are no cards to roll against yet. Build one and push it to Supabase:
            <code>npm run catalogue:build</code> then <code>npm run catalogue:push</code>.
          </p>
        </section>

        <!-- the pack -->
        <section v-else-if="status" class="hero" :class="{ 'is-ready': status.available }">
          <span class="hero__tl" aria-hidden="true" /><span class="hero__br" aria-hidden="true" />

          <div class="hero__art">
            <div v-if="alreadyOpened" class="hero__pull">
              <LomCard :card="status.claim!.card" />
            </div>
            <div v-else class="pack" aria-hidden="true">
              <span class="pack__seal pack__seal--top" /><span class="pack__seal pack__seal--bottom" />
              <span class="pack__tear" />
              <span class="pack__mark">
                <svg viewBox="0 0 28 28"><path d="M14 2l12 12-12 12L2 14z" fill="none" stroke="currentColor" stroke-width="1.2" /><path d="M14 7.5L20.5 14 14 20.5 7.5 14z" fill="currentColor" /></svg>
              </span>
              <span class="pack__name"><small>LOM</small><b>Daily</b></span>
              <span class="pack__count">1 player card</span>
            </div>
          </div>

          <div class="hero__text">
            <template v-if="status.available">
              <p class="hero__state"><i aria-hidden="true" />Ready to open</p>
              <h1 class="hero__title">Today's pack</h1>
              <p class="hero__lede">One player card from any season. The next one lands tomorrow at {{ status.hour }}:00.</p>
              <button class="btn btn--lg hero__cta" type="button" data-sound="select" :disabled="opening" @click="open">
                {{ opening ? 'Opening' : 'Open pack' }}
              </button>
            </template>

            <template v-else-if="alreadyOpened">
              <p class="hero__state hero__state--quiet">Today's pull</p>
              <h1 class="hero__title">{{ status.claim!.card.playerName }} <span class="hero__year">{{ status.claim!.card.season }}</span></h1>
              <p v-if="status.claim!.wasDuplicate" class="hero__lede">
                A duplicate: it became +{{ status.claim!.xpAwarded }} XP on the card you hold.
              </p>
              <p class="hero__next">Next pack in <b class="num">{{ remaining }}</b></p>
              <p class="faint hero__tz">{{ status.hour }}:00 {{ status.timeZone.replace('_', ' ') }}</p>
            </template>

            <template v-else>
              <p class="hero__state hero__state--quiet">Daily pack</p>
              <h1 class="hero__title">Next pack</h1>
              <p class="hero__next"><b class="num">{{ remaining }}</b></p>
              <p class="faint hero__tz">{{ status.hour }}:00 {{ status.timeZone.replace('_', ' ') }}</p>
            </template>

          </div>

          <!-- pity, always visible: hidden pity is just anxiety -->
          <div class="pity">
            <div>
              <p><span>Legendary within</span><b class="tnum">{{ status.pity.legendaryIn }}</b></p>
              <div class="meter"><i :style="{ width: `${legendaryShare}%` }" /></div>
            </div>
            <div>
              <p><span>Icon within</span><b class="tnum">{{ status.pity.iconIn }}</b></p>
              <div class="meter meter--prism"><i :style="{ width: `${iconShare}%` }" /></div>
            </div>
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
              <NuxtLink class="btn btn--sm" :to="`/duel/${liveDuelId}`">Rejoin</NuxtLink>
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

        <section>
          <div class="sect"><h2>Shop</h2><NuxtLink class="sect__link" to="/shop">All packs</NuxtLink></div>
          <NuxtLink class="shopline" to="/shop">
            <span><b>More packs</b><span class="faint">Squad packs, and better odds for a price</span></span>
            <span class="credits"><i class="coin" aria-hidden="true" />{{ (status?.credits ?? credits ?? 0).toLocaleString('en') }}</span>
          </NuxtLink>
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

.hero__art { grid-area: art; }
.hero__text { grid-area: text; }
.pity { grid-area: pity; display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding-top: 16px; margin-top: 2px; border-top: 1px solid var(--line-1); }
.pity p { display: flex; justify-content: space-between; align-items: baseline; margin: 0 0 6px; font-size: 12px; color: var(--ink-3); }
.pity b { font-size: 13px; color: var(--ink-1); }

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

.empty code { font-family: ui-monospace, monospace; font-size: 0.86em; padding: 0.12em 0.4em; border-radius: 2px; background: var(--bg-3); color: var(--ink-1); }

/* --- the reveal ------------------------------------------------------------- */
.reveal-page {
  min-height: 100svh;
  display: grid;
  align-content: center;
  gap: 8px;
  padding: max(12px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
  background: radial-gradient(70% 45% at 50% 44%, #101a2c, var(--bg-0) 75%);
}
.reveal-page__dupe { max-width: 420px; margin: 0 auto; }

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
