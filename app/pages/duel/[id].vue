<script setup lang="ts">
import { splashUrl, squareUrl } from '@lom/card-engine';
import { SLOTS, PHASE_LABEL, type Slot } from '~~/shared/draft';

/**
 * The room.
 *
 * One screen for the whole duel, in four phases: who you drew, the draft, the match, the
 * result. It is one screen rather than a draft page and a replay page because the two people
 * in it never leave each other — the moment one of them has to navigate somewhere, the other
 * is alone, and whatever they were doing together is over.
 *
 * Everything on it is driven by useDuelRoom, which holds the realtime subscription and the
 * corrected clock. This component has no clock, no poll, and no opinion about when a phase
 * ends. That is the design: both players' screens are functions of the same server instants,
 * so they turn over together.
 *
 * What used to be here and is not any more: a 700 ms `setInterval` asking for the whole duel,
 * and a POST per hover.
 */

const route = useRoute();
const id = route.params.id as string;

const {
  state, pool, error: roomError, loading, live,
  phase, matchClock, secondsLeft, lobbyLeft,
  theirHover, opponentHere, sendHover,
} = useDuelRoom(id);

const actionError = ref('');
const busy = ref(false);
const search = ref('');
const chosenSlot = ref<Slot | null>(null);
const selected = ref<{ key: string; name: string } | null>(null);

const error = computed(() => actionError.value || roomError.value);

// A new turn, or a turn that is not ours, invalidates whatever was being considered.
watch(() => [state.value?.turn, state.value?.myTurn], () => {
  selected.value = null;
  chosenSlot.value = null;
  actionError.value = '';
});

const mySide = computed(() => state.value?.side);
const theirSide = computed(() => (state.value?.side === 'BLUE' ? 'RED' : 'BLUE'));
const isPick = computed(() => state.value?.step?.kind === 'PICK');

const taken = computed(() => new Set((state.value?.actions || []).map((a: any) => a.championKey)));
const myLineup = computed(() =>
  (state.value?.side === 'BLUE' ? state.value?.blueLineup : state.value?.redLineup) || {});

const myFilled = computed(() => new Set(
  (state.value?.actions || [])
    .filter((a: any) => a.side === state.value?.side && a.slot)
    .map((a: any) => a.slot),
));
const openSlots = computed(() => SLOTS.filter((s) => !myFilled.value.has(s)));

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
 * Two steps, as the real client does and docs/05 section 3.3 describes. A single tap
 * committing is unforgiving on a phone — a mis-tap spends a ban — and it also leaves the
 * opponent with nothing to watch until the action is already over.
 *
 * The hover now goes out as a broadcast on the room channel rather than a POST that writes a
 * column. It arrives in one hop, costs no database write, and cannot be mistaken for state:
 * nothing persists it and nothing reads it back.
 */
function consider(c: { key: string; name: string }) {
  if (!state.value?.myTurn || busy.value || phase.value !== 'DRAFT') return;
  selected.value = c;
  sendHover({
    side: state.value.side!,
    kind: state.value.step.kind,
    turn: state.value.turn,
    championKey: c.key,
    championName: c.name,
    slot: isPick.value ? (chosenSlot.value || bestSlotFor(c.key)) : null,
  });
}

// Moving the slot while a champion is already in hand is a change the other side should see.
watch(chosenSlot, (slot) => {
  if (!selected.value || !state.value?.myTurn || !isPick.value) return;
  sendHover({
    side: state.value.side!,
    kind: 'PICK',
    turn: state.value.turn,
    championKey: selected.value.key,
    championName: selected.value.name,
    slot: slot || bestSlotFor(selected.value.key),
  });
});

async function lockIn() {
  if (busy.value || !state.value?.myTurn || !selected.value) return;
  const slot = isPick.value ? (chosenSlot.value || bestSlotFor(selected.value.key)) : null;
  if (isPick.value && !slot) {
    actionError.value = 'Pick a lineup slot first.';
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
    sendHover(null);
    // No reload: the insert is pushed to both clients, including this one.
  } catch (e: any) {
    actionError.value = e?.data?.statusMessage || e?.message || 'That did not go through.';
  } finally {
    busy.value = false;
  }
}

const sideActions = (side: string, kind: string) =>
  (state.value?.actions || []).filter((a: any) => a.side === side && a.kind === kind);

/**
 * Both go through the card engine's resolver rather than interpolating a CDN path here,
 * because a champion key is not always the id Data Dragon files its art under — "Kai'Sa"
 * is `Kaisa`, "Cho'Gath" is `Chogath`. See packages/card-engine/src/assets.js.
 */
/** Square portrait, for bans and the picker grid. */
const art = (key: string) => squareUrl(key);
/** Tall loading art for the pick panels — 308x560, the shape the broadcast layout wants. */
const splash = (key: string) => splashUrl(key, 'card');

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

const nameOf = (side: string) =>
  side === mySide.value ? 'You' : state.value?.opponent || 'Opponent';

/** Names for the scoreboard during the watch, in blue/red order rather than mine/theirs. */
const blueName = computed(() => nameOf('BLUE'));
const redName = computed(() => nameOf('RED'));

/**
 * Where to show the match. The shared clock while it is running, the end once it is not.
 *
 * The second half is not just belt and braces. A duel that finished before migration 0007 has
 * a result but no `watch_start_at`, so its shared clock is zero forever — and opening one from
 * history rendered an untouched map and a 0-0 scoreboard above the final box score, which reads
 * as a broken replay rather than an old one. At RESULT the match is over by definition, so the
 * honest frame is the last one.
 */
const watchAt = computed(() => {
  if (phase.value === 'RESULT') return state.value?.result?.gameLength ?? 0;
  return matchClock.value;
});

useHead({ title: 'Duel — LOM' });
</script>

<template>
  <main class="page" :class="{ 'page--wide': phase === 'WATCH' || phase === 'RESULT' }">
    <header class="topbar">
      <h1>
        <template v-if="phase === 'LOBBY'">Match found</template>
        <template v-else-if="phase === 'DRAFT'">Draft</template>
        <template v-else-if="phase === 'WATCH'">Live</template>
        <template v-else>Result</template>
      </h1>
      <span class="topbar__meta">
        vs {{ state?.opponent || '…' }}
        <!-- Only worth saying when it is not true: a live room says nothing about itself. -->
        <span v-if="state && !live" class="faint"> · reconnecting</span>
      </span>
    </header>

    <p v-if="error" class="notice notice--bad">{{ error }}</p>
    <div v-if="loading" class="skeleton draft-skeleton" />

    <!-- ===== Lobby: who you drew, and a few seconds to see it ================= -->
    <section v-else-if="phase === 'LOBBY'" class="lobby">
      <p class="eyebrow">Paired</p>
      <p class="lobby__vs">
        <strong>You</strong>
        <span class="lobby__x">vs</span>
        <strong>{{ state?.opponent }}</strong>
      </p>
      <p class="lobby__side">
        You are <strong :class="`is-${(mySide || '').toLowerCase()}`">{{ mySide }}</strong>
        <span class="faint">
          · {{ mySide === 'BLUE' ? 'first ban and first pick' : 'last pick' }}
        </span>
      </p>
      <p v-if="state?.isBot" class="lobby__note faint">
        Nobody was searching, so the agent is taking the other side.
      </p>
      <p v-else class="lobby__note faint">
        {{ opponentHere ? 'They are here.' : 'Waiting for them to load…' }}
      </p>
      <p class="lobby__count tnum">{{ Math.ceil(lobbyLeft) }}</p>
      <p class="lobby__note faint">Bans open in a moment. Nobody's clock is running yet.</p>
    </section>

    <!-- ===== The shared watch, and then the result ============================ -->
    <template v-else-if="(phase === 'WATCH' || phase === 'RESULT') && state?.result">
      <p v-if="phase === 'WATCH'" class="notice notice--live">
        You are both watching this live. Same clock, same second — there is nothing to skip to.
      </p>
      <MatchWatch
        :result="state.result"
        :clock="watchAt"
        :blue-name="blueName"
        :red-name="redName"
        :my-side="mySide"
        :show-result="phase === 'RESULT'"
      />
      <div v-if="phase === 'RESULT'" class="again">
        <NuxtLink class="btn" to="/duels">Battle again</NuxtLink>
      </div>
    </template>

    <!-- The draft finished but the result has not arrived on this client yet. -->
    <section v-else-if="phase === 'WATCH' || phase === 'RESULT'" class="lobby">
      <p class="eyebrow">Drafted</p>
      <p class="lobby__note">Both fives are in. Loading the match…</p>
    </section>

    <!-- ===== The draft ======================================================= -->
    <template v-else-if="state && phase === 'DRAFT'">
      <section class="panel clock" :class="{ 'is-mine': state.myTurn }">
        <div>
          <p class="eyebrow">{{ state.step ? PHASE_LABEL[state.step.phase] : 'Draft' }}</p>
          <p class="clock__who">
            <template v-if="state.myTurn">Your {{ isPick ? 'pick' : 'ban' }}</template>
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
          <div class="bans">
            <span class="bans__who">
              {{ nameOf(side) }}
              <span class="bans__side">{{ side }}</span>
            </span>
            <span v-for="n in 5" :key="n" class="bans__slot">
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
              :class="{
                'is-empty': !pickFor(side, slot),
                'is-live': state.step?.kind === 'PICK' && state.step?.side === side,
              }"
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
          <p class="eyebrow">
            Champions <span class="faint">({{ champions.filter(c => !c.gone).length }} left)</span>
          </p>
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

    <!-- A challenge that was never answered, or one that was withdrawn. -->
    <section v-else-if="state" class="panel done">
      <p class="eyebrow">{{ phase === 'PENDING' ? 'Waiting' : 'Over' }}</p>
      <p class="muted">
        <template v-if="phase === 'PENDING'">
          This challenge has not been answered yet.
        </template>
        <template v-else>This duel never started.</template>
      </p>
      <NuxtLink class="btn" to="/duels">Back to Battle</NuxtLink>
    </section>
  </main>
</template>

<style scoped>
.draft-skeleton { height: 60vh; }

/* --- lobby -------------------------------------------------------------- */

.lobby {
  display: grid;
  justify-items: center;
  gap: 8px;
  text-align: center;
  padding: 40px 16px;
}
.lobby__vs { display: flex; align-items: center; gap: 12px; font-size: 19px; margin: 2px 0; }
.lobby__x {
  font-family: var(--font-label, inherit);
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink-dim, #8fa3c0);
}
.lobby__side { font-size: 14px; margin: 0; }
.lobby__side .is-blue { color: #5ec8f0; }
.lobby__side .is-red { color: #ff6f6a; }
.lobby__note { font-size: 13px; margin: 0; max-width: 34ch; }
.lobby__count {
  font-family: var(--font-display, inherit);
  font-size: 54px;
  font-weight: 700;
  line-height: 1;
  margin: 10px 0 2px;
}

.notice--live { border-color: var(--accent, #67d3f2); }

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
.champ.is-picked { border-color: var(--accent, #67d3f2); }
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

/* Their hover sits in the slot, half-there, until they commit to it. */
.pick__art--hover { opacity: 0.4; filter: saturate(0.6); animation: hoverpulse 1.4s ease-in-out infinite; }
@keyframes hoverpulse { 0%, 100% { opacity: 0.28; } 50% { opacity: 0.5; } }

.done { display: grid; gap: 8px; justify-items: start; }
.again { margin-top: 18px; text-align: center; }
</style>
