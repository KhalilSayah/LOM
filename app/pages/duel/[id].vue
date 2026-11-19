<script setup lang="ts">
import { SLOTS, PHASE_LABEL, type Slot } from '~~/shared/draft';

/**
 * The draft.
 *
 * Polls once a second. The server is the only thing that knows whose turn it is, what is
 * still available and whether the clock ran out, so this screen asks rather than decides —
 * it renders a countdown from the server's `deadlineAt` corrected by a measured clock
 * offset, and a disagreement is simply this client being wrong.
 *
 * Both lineups and both champion pools are open from the first ban (docs/05 section 2),
 * because banning is only interesting when you know what you are banning against.
 */

const route = useRoute();
const id = route.params.id as string;

const state = ref<any>(null);
const pool = ref<Array<{ key: string; name: string }>>([]);
const error = ref('');
const busy = ref(false);
const search = ref('');
const chosenSlot = ref<Slot | null>(null);
const loading = ref(true);

/** Server time minus ours, so a wrong device clock cannot break the countdown. */
let drift = 0;
const now = ref(Date.now());
let poller: ReturnType<typeof setInterval> | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;

async function load(withPool = false) {
  try {
    const sentAt = Date.now();
    const next = await $fetch<any>(`/api/duel/${id}${withPool ? '?pool=1' : ''}`);
    /**
     * Clock offset, corrected for the round trip.
     *
     * `serverNow` was true when the server wrote it, which is roughly half a round trip
     * before it arrived here. Taking it at face value leaves each device out by its own
     * latency, so two phones on different connections show different numbers for the same
     * deadline — which is exactly what it looked like. Charging half the measured round
     * trip puts them within a few tens of milliseconds of each other.
     */
    const rtt = Date.now() - sentAt;
    drift = new Date(next.serverNow).getTime() + rtt / 2 - Date.now();
    if (next.pool) pool.value = next.pool;
    // A new turn, or someone else's turn, invalidates whatever was being considered here.
    if (state.value && (next.turn !== state.value.turn || !next.myTurn)) {
      selected.value = null;
      chosenSlot.value = null;
    }
    state.value = next;
    error.value = '';
  } catch (e: any) {
    // Keep the last good state on screen. A dropped poll on a phone is ordinary, and
    // blanking the draft every time one fails is worse than being a second stale.
    error.value = e?.data?.statusMessage || e?.message || 'Reconnecting…';
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await load(true);
  // Fast enough that the other side's lock looks immediate; the endpoint is two indexed
  // reads and the heavy per-catalogue work is cached in the server process.
  poller = setInterval(() => { if (state.value?.status === 'DRAFTING') load(); }, 700);
  ticker = setInterval(() => { now.value = Date.now(); }, 200);
});
onBeforeUnmount(() => { clearInterval(poller); clearInterval(ticker); });

const secondsLeft = computed(() => {
  if (!state.value?.deadlineAt) return null;
  const ms = new Date(state.value.deadlineAt).getTime() - (now.value + drift);
  return Math.max(0, Math.ceil(ms / 1000));
});

const taken = computed(() => new Set((state.value?.actions || []).map((a: any) => a.championKey)));
const myLineup = computed(() => (state.value?.side === 'BLUE' ? state.value?.blueLineup : state.value?.redLineup) || {});
const theirLineup = computed(() => (state.value?.side === 'BLUE' ? state.value?.redLineup : state.value?.blueLineup) || {});

const myFilled = computed(() => new Set(
  (state.value?.actions || [])
    .filter((a: any) => a.side === state.value?.side && a.slot)
    .map((a: any) => a.slot),
));
const openSlots = computed(() => SLOTS.filter((s) => !myFilled.value.has(s)));

const isPick = computed(() => state.value?.step?.kind === 'PICK');

const champions = computed(() => {
  const q = search.value.trim().toLowerCase();
  return pool.value
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .map((c) => ({ ...c, gone: taken.value.has(c.key) }));
});

/** What each of my cards would be worth on this champion — the reason to pick it. */
function masteryOn(lineup: any, slot: Slot, championKey: string): number {
  return lineup?.[slot]?.pool?.[championKey] ?? 0;
}

const bestSlotFor = (championKey: string): Slot | null => {
  let best: Slot | null = null;
  let top = -1;
  for (const slot of openSlots.value) {
    const m = masteryOn(myLineup.value, slot, championKey);
    if (m > top) { top = m; best = slot; }
  }
  return best;
};

/**
 * Tapping a champion considers it; locking it in commits.
 *
 * Two steps rather than one, as the real client does and docs/05 section 3.3 describes.
 * A single tap committing is unforgiving on a phone — a mis-tap spends a ban — and it also
 * leaves the opponent with nothing to watch until the action is already over. The hover is
 * most of what makes the draft feel live for the person who is not acting.
 */
const selected = ref<{ key: string; name: string } | null>(null);

function consider(c: { key: string; name: string }) {
  if (!state.value?.myTurn || busy.value) return;
  selected.value = c;
  // Fire and forget: a hover is something to look at, not a claim on a champion.
  $fetch(`/api/duel/${id}/hover`, {
    method: 'POST',
    body: { championKey: c.key, championName: c.name, slot: isPick.value ? (chosenSlot.value || bestSlotFor(c.key)) : null },
  }).catch(() => {});
}

async function lockIn() {
  if (busy.value || !state.value?.myTurn || !selected.value) return;
  const slot = isPick.value ? (chosenSlot.value || bestSlotFor(selected.value.key)) : null;
  if (isPick.value && !slot) {
    error.value = 'Pick a lineup slot first.';
    return;
  }
  busy.value = true;
  try {
    await $fetch(`/api/duel/${id}/action`, {
      method: 'POST',
      body: { championKey: selected.value.key, slot },
    });
    selected.value = null;
    chosenSlot.value = null;
    search.value = '';
    await load();
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'That did not go through.';
    await load();
  } finally {
    busy.value = false;
  }
}

/** Whatever the side on the clock is considering, mine or theirs. */
const hover = computed(() => state.value?.hover || null);
const theirHover = computed(() => (hover.value && hover.value.side !== state.value?.side ? hover.value : null));

const sideActions = (side: string, kind: string) =>
  (state.value?.actions || []).filter((a: any) => a.side === side && a.kind === kind);

const mySide = computed(() => state.value?.side);
const theirSide = computed(() => (state.value?.side === 'BLUE' ? 'RED' : 'BLUE'));

const DDRAGON = 'https://ddragon.leagueoflegends.com/cdn/16.22.1/img/champion';
/** Square portrait, for bans and the picker grid. */
const art = (key: string) => `${DDRAGON}/${key}.png`;
/**
 * Tall loading art, for the pick panels. 308x560, which is the shape the broadcast
 * layout wants — the square portrait stretched to a panel looks like a mistake.
 */
const splash = (key: string) =>
  `https://ddragon.leagueoflegends.com/cdn/img/champion/loading/${key}_0.jpg`;

/** The pick that filled a slot for a side, if it has happened yet. */
const pickFor = (side: string, slot: Slot) =>
  (state.value?.actions || []).find((a: any) => a.side === side && a.kind === 'PICK' && a.slot === slot) || null;

/** Pick order within a side, so a panel can be labelled B1..B5 / R1..R5 like the broadcast. */
const pickIndex = (side: string, slot: Slot) => {
  const picks = (state.value?.actions || []).filter((a: any) => a.side === side && a.kind === 'PICK');
  const at = picks.findIndex((a: any) => a.slot === slot);
  return at >= 0 ? at + 1 : null;
};

const lineupOf = (side: string) =>
  (side === 'BLUE' ? state.value?.blueLineup : state.value?.redLineup) || {};

useHead({ title: 'Draft — LOM' });
</script>

<template>
  <main class="page">
    <header class="topbar">
      <h1>Draft</h1>
      <span class="topbar__meta">vs {{ state?.opponent || '…' }}</span>
    </header>

    <p v-if="error" class="notice notice--bad">{{ error }}</p>
    <div v-if="loading" class="skeleton draft-skeleton" />

    <!-- the match is done -->
    <section v-else-if="state?.status === 'COMPLETE'" class="panel done">
      <p class="eyebrow">Result</p>
      <h2 class="done__head">
        {{ state.result?.winner === mySide ? 'You won' : 'You lost' }}
      </h2>
      <p class="muted">
        {{ state.result?.winner }} closed it out
        <template v-if="state.result?.durationLabel"> in {{ state.result.durationLabel }}</template>.
      </p>
      <NuxtLink class="btn" :to="`/replay?duel=${id}`">Watch the match</NuxtLink>
    </section>

    <template v-else-if="state">
      <!-- clock and whose turn -->
      <section class="panel clock" :class="{ 'is-mine': state.myTurn }">
        <div>
          <p class="eyebrow">{{ state.step ? PHASE_LABEL[state.step.phase] : 'Draft' }}</p>
          <p class="clock__who">
            <template v-if="state.myTurn">
              Your {{ isPick ? 'pick' : 'ban' }}
            </template>
            <template v-else-if="theirHover">
              {{ state.opponent }} is looking at <strong>{{ theirHover.championName }}</strong>
            </template>
            <template v-else>Waiting for {{ state.opponent }}</template>
          </p>
        </div>
        <p class="clock__n tnum" :class="{ 'is-low': (secondsLeft ?? 99) <= 5 }">
          {{ secondsLeft ?? '—' }}
        </p>
      </section>

      <!-- the board, laid out like the broadcast: blue above, red below -->
      <section class="board">
        <div v-for="side in ['BLUE', 'RED']" :key="side" class="rail" :class="`rail--${side.toLowerCase()}`">
          <!-- bans run along the edge of each side's rail -->
          <div class="bans">
            <span class="bans__who">
              {{ side === mySide ? 'You' : state.opponent }}
              <span class="bans__side">{{ side }}</span>
            </span>
            <span
              v-for="n in 5"
              :key="n"
              class="bans__slot"
            >
              <img
                v-if="sideActions(side, 'BAN')[n - 1]"
                :src="art(sideActions(side, 'BAN')[n - 1].championKey)"
                :alt="sideActions(side, 'BAN')[n - 1].championName"
                class="bans__art"
              >
            </span>
          </div>

          <ul class="picks">
            <li
              v-for="slot in SLOTS"
              :key="slot"
              class="pick"
              :class="{ 'is-empty': !pickFor(side, slot), 'is-live': state.step?.kind === 'PICK' && state.step?.side === side }"
            >
              <img
                v-if="pickFor(side, slot)"
                :src="splash(pickFor(side, slot).championKey)"
                :alt="pickFor(side, slot).championName"
                class="pick__art"
                loading="lazy"
              >
              <img
                v-else-if="theirHover && theirHover.kind === 'PICK' && theirHover.side === side && theirHover.slot === slot"
                :src="splash(theirHover.championKey)"
                :alt="theirHover.championName"
                class="pick__art pick__art--hover"
              >
              <span v-if="pickIndex(side, slot)" class="pick__n">
                {{ side === 'BLUE' ? 'B' : 'R' }}{{ pickIndex(side, slot) }}
              </span>
              <span class="pick__role">{{ slot }}</span>
              <span class="pick__name">{{ lineupOf(side)[slot]?.name || '—' }}</span>
            </li>
          </ul>
        </div>
      </section>

      <!-- choose a slot before picking -->
      <section v-if="state.myTurn && isPick" class="panel slotpick">
        <p class="eyebrow">Put it in</p>
        <div class="slotpick__row">
          <button
            v-for="slot in openSlots"
            :key="slot"
            class="slotpick__btn"
            :class="{ 'is-on': chosenSlot === slot }"
            type="button"
            @click="chosenSlot = chosenSlot === slot ? null : slot"
          >
            <span>{{ slot }}</span>
            <span class="faint">{{ myLineup[slot]?.name || '—' }}</span>
          </button>
        </div>
        <p class="faint slotpick__note">
          Leave it unchosen and the champion goes to whichever open slot has the most mastery on it.
        </p>
      </section>

      <!-- what you are about to do, and the commit -->
      <section v-if="state.myTurn" class="lockbar" :class="{ 'is-armed': selected }">
        <span class="lockbar__pick">
          <img v-if="selected" :src="art(selected.key)" :alt="selected.name" class="lockbar__art">
          <span v-else class="lockbar__hole" aria-hidden="true" />
          <span class="lockbar__text">
            <strong>{{ selected ? selected.name : 'Choose a champion' }}</strong>
            <span v-if="selected && isPick" class="faint lockbar__sub">
              into {{ chosenSlot || bestSlotFor(selected.key) }}
            </span>
            <span v-else-if="!selected" class="faint lockbar__sub">Tap one below, then lock it in.</span>
          </span>
        </span>
        <button class="btn lockbar__go" type="button" :disabled="!selected || busy" @click="lockIn">
          {{ busy ? 'Locking' : `Lock ${isPick ? 'pick' : 'ban'} in` }}
        </button>
      </section>

      <!-- the pool -->
      <section class="pool">
        <div class="pool__head">
          <p class="eyebrow">Champions <span class="faint">({{ champions.filter(c => !c.gone).length }} left)</span></p>
          <input v-model="search" class="pool__search" type="search" placeholder="Search champions">
        </div>
        <ul class="pool__grid">
          <li v-for="c in champions" :key="c.key">
            <button
              class="champ"
              :class="{
                'is-gone': c.gone,
                'is-ready': state.myTurn && !c.gone,
                'is-picked': selected?.key === c.key,
              }"
              type="button"
              :disabled="c.gone || !state.myTurn || busy"
              :title="c.name"
              @click="consider({ key: c.key, name: c.name })"
            >
              <img :src="art(c.key)" :alt="c.name" loading="lazy">
              <span class="champ__name">{{ c.name }}</span>
              <span v-if="isPick && !c.gone" class="champ__m tnum">
                {{ Math.max(0, ...openSlots.map(s => masteryOn(myLineup, s, c.key))) }}
              </span>
            </button>
          </li>
        </ul>
      </section>
    </template>
  </main>
</template>

<style scoped>
.draft-skeleton { height: 60vh; }

.clock { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.clock.is-mine { border-color: var(--accent, #67d3f2); }
.clock__who { font-size: 17px; font-weight: 600; }
.clock__n { font-size: 30px; font-weight: 700; }
.clock__n.is-low { color: #ff8a8a; }

/* --- the board ----------------------------------------------------------
   Laid out like the draft on a broadcast: each side gets a rail, its bans along
   the edge and its five picks as tall splash panels with the player's name down
   the side. The art is the point — a pick is a champion and a person, and a row
   of text says neither. */

.board { display: grid; gap: 8px; margin-top: 12px; }

.rail {
  border-radius: 10px;
  overflow: hidden;
  background: var(--surface-1, #141a26);
  border: 1px solid var(--line, #2b3448);
}
.rail--blue { border-top: 3px solid #3b82f6; }
.rail--red { border-top: 3px solid #ef4444; }

.bans {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  background: rgba(0, 0, 0, 0.35);
}
.bans__who {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin-right: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bans__side { color: var(--ink-dim, #8fa3c0); font-weight: 400; margin-left: 6px; }
.bans__slot {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--line, #2b3448);
  display: block;
  flex: none;
}
.bans__art {
  width: 100%;
  height: 100%;
  display: block;
  border-radius: 3px;
  filter: grayscale(1) brightness(0.65);
}

.picks {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 2px;
  list-style: none;
  padding: 0;
  margin: 0;
}

.pick {
  position: relative;
  aspect-ratio: 9 / 16;
  overflow: hidden;
  background: #0b0f17;
  display: block;
}
.pick.is-empty { background: repeating-linear-gradient(135deg, #0d131d 0 8px, #101723 8px 16px); }
/* The side that is currently picking gets a quiet pulse on its empty slots. */
.pick.is-live.is-empty { box-shadow: inset 0 0 0 1px var(--accent, #67d3f2); }

.pick__art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  /* The loading art is framed for a portrait card; pushing the crop up keeps the
     champion's face in the panel rather than their chest. */
  object-position: 50% 18%;
}

.pick__n {
  position: absolute;
  top: 3px;
  right: 4px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: #fff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
}
.pick__role {
  position: absolute;
  top: 3px;
  left: 4px;
  font-size: 9px;
  letter-spacing: 0.08em;
  color: rgba(255, 255, 255, 0.72);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
}

/* The player's name down the side, as the broadcast does it. */
.pick__name {
  position: absolute;
  left: 5px;
  bottom: 6px;
  /* Reads bottom-to-top up the left edge. writing-mode keeps the element's own box
     tall and narrow, so left/bottom mean what they look like they mean — rotating a
     normal box about its corner instead puts it outside the panel, where the panel's
     overflow:hidden quietly eats it. */
  writing-mode: vertical-rl;
  transform: rotate(180deg);
  white-space: nowrap;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #fff;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.95);
  max-height: 86%;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (min-width: 720px) {
  .board { gap: 10px; }
  .pick__name { font-size: 13px; }
  .bans__slot { width: 30px; height: 30px; }
}

.slotpick { margin-top: 12px; }
.slotpick__row { display: flex; flex-wrap: wrap; gap: 6px; }
.slotpick__btn {
  display: grid; gap: 1px; padding: 6px 10px; border-radius: 8px;
  border: 1px solid var(--line, #2b3448); background: var(--surface-2, #1b2230);
  color: inherit; font: inherit; font-size: 12px; cursor: pointer; text-align: left;
}
.slotpick__btn.is-on { border-color: var(--accent, #67d3f2); }
.slotpick__note { font-size: 11px; margin-top: 6px; }

.pool { margin-top: 14px; }
.pool__head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
.pool__search {
  flex: 0 1 200px; padding: 6px 10px; border-radius: 8px; font: inherit; font-size: 13px;
  border: 1px solid var(--line, #2b3448); background: var(--surface-1, #141a26); color: var(--ink, #e4ebf6);
}
.pool__grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(62px, 1fr));
  gap: 6px; list-style: none; padding: 0; margin: 0;
}
.champ {
  position: relative; width: 100%; padding: 0; border: 2px solid transparent; border-radius: 8px;
  background: none; cursor: pointer; display: grid; gap: 2px; color: inherit;
}
.champ img { width: 100%; height: auto; display: block; border-radius: 6px; }
.champ__name { font-size: 9px; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.champ__m {
  position: absolute; top: 2px; right: 2px; font-size: 9px; font-weight: 700;
  padding: 0 3px; border-radius: 3px; background: rgba(6, 10, 16, 0.8);
}
.champ.is-gone { opacity: 0.22; cursor: not-allowed; filter: grayscale(1); }
.champ.is-ready:hover { border-color: var(--accent, #67d3f2); }
.champ:disabled { cursor: not-allowed; }


/* --- lock bar ------------------------------------------------------------ */

.lockbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  padding: 8px 10px;
  border-radius: 12px;
  border: 1px solid var(--line, #2b3448);
  background: var(--surface-1, #141a26);
  position: sticky;
  bottom: calc(var(--nav-h, 62px) + 8px);
  z-index: 5;
}
.lockbar.is-armed { border-color: var(--accent, #67d3f2); }
.lockbar__pick { display: flex; align-items: center; gap: 10px; min-width: 0; }
.lockbar__art { width: 38px; height: 38px; border-radius: 7px; display: block; }
.lockbar__hole {
  width: 38px; height: 38px; border-radius: 7px;
  border: 1px dashed var(--line, #2b3448); display: block;
}
.lockbar__text { display: grid; min-width: 0; }
.lockbar__text strong { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lockbar__sub { font-size: 11px; }
.lockbar__go { white-space: nowrap; }

.champ.is-picked { border-color: var(--accent, #67d3f2); }

/* Their hover sits in the slot, half-there, until they commit to it. */
.pick__art--hover { opacity: 0.4; filter: saturate(0.6); animation: hoverpulse 1.4s ease-in-out infinite; }
@keyframes hoverpulse { 0%, 100% { opacity: 0.28; } 50% { opacity: 0.5; } }

.done { display: grid; gap: 8px; justify-items: start; }
.done__head { font-size: 24px; }
</style>
