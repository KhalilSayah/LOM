<script setup lang="ts">
import { splashUrl, squareUrl } from '@lom/card-engine';
import { SLOTS, PHASE_LABEL, DRAFT_ORDER, ACTION_SECONDS, type Slot } from '~~/shared/draft';

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

const theirLineup = computed(() =>
  (state.value?.side === 'BLUE' ? state.value?.redLineup : state.value?.blueLineup) || {});
const theirFilled = computed(() => new Set(
  (state.value?.actions || [])
    .filter((a: any) => a.side !== state.value?.side && a.slot)
    .map((a: any) => a.slot),
));

/**
 * Which champions the grid shows. A pick wants yours, the champions your open slots know
 * best; a ban wants theirs, the ones their open slots would play. "All" is the full list.
 * It follows the step until the person chooses for themselves.
 */
type PoolView = 'mine' | 'theirs' | 'all';
const poolView = ref<PoolView>('mine');
const poolViewChosen = ref(false);
watch(isPick, (pick) => {
  if (!poolViewChosen.value) poolView.value = pick ? 'mine' : 'theirs';
}, { immediate: true });
function setPoolView(v: PoolView) {
  poolView.value = v;
  poolViewChosen.value = true;
}

const champions = computed(() => {
  const q = search.value.trim().toLowerCase();
  const theirOpen = SLOTS.filter((sl) => !theirFilled.value.has(sl));
  const list = pool.value
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .map((c) => ({
      ...c,
      gone: taken.value.has(c.key),
      mine: Math.max(0, ...openSlots.value.map((sl) => masteryOn(myLineup.value, sl, c.key))),
      theirs: Math.max(0, ...theirOpen.map((sl) => masteryOn(theirLineup.value, sl, c.key))),
    }));
  // A search looks through everything, whichever view is on.
  if (q || poolView.value === 'all') return list;
  const key = poolView.value;
  return list
    .filter((c) => c[key] > 0)
    .sort((a, b) => Number(a.gone) - Number(b.gone) || b[key] - a[key]);
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
/**
 * A finished match can be rewatched. The rewatch clock is this client's alone, so it is
 * only offered once both players are past the shared watch; until it is touched the result
 * shows its last frame, as before.
 */
const rewatch = ref<number | null>(null);
const transport = ref<any>(null);
const rewatchClock = computed({
  get: () => rewatch.value ?? matchEnd(state.value?.result),
  set: (t: number) => { rewatch.value = t; },
});
function seek(t: number) {
  rewatch.value = t;
  nextTick(() => transport.value?.play());
}

const watchAt = computed(() => {
  if (phase.value === 'RESULT') return rewatchClock.value;
  return matchClock.value;
});

// --- what it paid ------------------------------------------------------------------
/**
 * The payout, read off the receipt the server wrote (docs/01 section 5).
 *
 * Not recomputed here. A result screen that worked the numbers out for itself could
 * disagree with the ledger, and the ledger is what the Credits pill is counting — so this
 * renders what was actually granted, including the lines that paid nothing.
 */
const payout = computed(() => (state.value as any)?.rewards || null);
const payoutLines = computed<{ label: string; credits: number }[]>(() => payout.value?.detail?.lines ?? []);
const sponsorLines = computed<any[]>(() => payout.value?.detail?.sponsors ?? []);

/** Every starter got the same XP unless they graded S, so it reads as one line, not five. */
const xpSpread = computed(() => {
  const awards = (payout.value?.detail?.cardXp ?? []) as { name: string; xp: number; grade: string | null }[];
  if (!awards.length) return null;
  const base = Math.min(...awards.map((a) => a.xp));
  const standout = awards.filter((a) => a.xp > base);
  return { base, standout };
});

/** The pill in the header is a cached balance, and the match has just moved it. */
const { refresh: refreshWallet } = useWallet();
watch(payout, (paid) => { if (paid) refreshWallet(); }, { immediate: true });

// --- sound -------------------------------------------------------------------------
// The room's moments, voiced. Driven by the shared state rather than by clicks, so both
// players hear an action land when it lands, not when one of them pressed something.

watch(phase, (now, before) => {
  if (!before) {
    if (now === 'LOBBY') playSound('matchFound');
    return;
  }
  if (now === 'LOBBY') playSound('matchFound');
  if (before === 'DRAFT' && (now === 'WATCH' || now === 'RESULT')) playSound('draftDone');
  if (now === 'RESULT' && before === 'WATCH' && state.value?.result) {
    playSound(state.value.result.winner === mySide.value ? 'victory' : 'defeat');
  }
});

watch(() => state.value?.actions?.length ?? 0, (n, prev) => {
  if (prev === undefined || n <= prev) return;
  const last = state.value?.actions?.[n - 1];
  if (!last) return;
  if (last.side === mySide.value) playSound(last.kind === 'BAN' ? 'ban' : 'lockIn');
  else playSound(last.kind === 'BAN' ? 'ban' : 'theirLock');
});

watch(() => state.value?.myTurn, (mine, was) => {
  if (mine && !was && phase.value === 'DRAFT') playSound('yourTurn');
});

watch(secondsLeft, (s) => {
  if (s === null || !state.value?.myTurn || phase.value !== 'DRAFT') return;
  if (s <= 5 && s > 0) playSound('timerUrgent');
  else if (s <= 10 && s > 0) playSound('timerTick');
});

/** The twenty steps as a rail: done, now, still to come — and whose each one is. */
const seq = computed(() => DRAFT_ORDER.map((step, i) => ({
  i,
  side: step.side === 'BLUE' ? 'b' : 'r',
  ban: step.kind === 'BAN',
  state: i < (state.value?.turn ?? 0) ? 'done' : i === (state.value?.turn ?? -1) ? 'now' : 'next',
})));

/** How much of the clock is left, for the draining bar. Bonus time overfills it, so clamp. */
const timerShare = computed(() => Math.max(0, Math.min(100, ((secondsLeft.value ?? 0) / ACTION_SECONDS) * 100)));
const lowTime = computed(() => (secondsLeft.value ?? 99) <= 10);

useHead(() => ({
  // The tab title carries the turn, for a draft left in a background tab.
  title: phase.value === 'DRAFT' && state.value?.myTurn ? `Your ${isPick.value ? 'pick' : 'ban'} — LOM` : 'Duel — LOM',
}));
</script>


<template>
  <main class="room" :class="[`room--${(phase || 'loading').toLowerCase()}`, { 'has-lock': phase === 'DRAFT' && state?.myTurn }]">
    <header class="room__bar">
      <NuxtLink class="icon-btn" to="/duels" aria-label="Leave the room">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </NuxtLink>
      <p class="room__vs">
        <template v-if="phase === 'LOBBY'">Match found</template>
        <template v-else-if="phase === 'DRAFT'">Draft</template>
        <template v-else-if="phase === 'WATCH'">Live</template>
        <template v-else>Result</template>
        <span class="faint"> vs </span><b>{{ state?.opponent || '…' }}</b>
        <span v-if="state && !live" class="faint room__reconnect"> · reconnecting</span>
      </p>
      <span v-if="mySide" class="tag" :class="mySide === 'BLUE' ? 'tag--blue' : 'tag--red'">{{ mySide === 'BLUE' ? 'You are blue' : 'You are red' }}</span>
      <span v-else />
    </header>

    <div class="room__body">
      <p v-if="error" class="notice notice--bad">{{ error }}</p>
      <div v-if="loading" class="skeleton room__skeleton" />

      <!-- ===== Lobby: who you drew, and a few seconds to see it ================= -->
      <section v-else-if="phase === 'LOBBY'" class="lobby">
        <p class="lobby__state"><i aria-hidden="true" />Paired</p>
        <div class="lobby__vs">
          <div class="lobby__who" :class="`is-${(mySide || '').toLowerCase()}`">
            <span class="lobby__avatar">You</span>
            <b>You</b>
            <span class="faint">{{ mySide === 'BLUE' ? 'Blue side' : 'Red side' }}</span>
          </div>
          <span class="lobby__x">VS</span>
          <div class="lobby__who" :class="`is-${mySide === 'BLUE' ? 'red' : 'blue'}`">
            <span class="lobby__avatar">{{ (state?.opponent || '?').slice(0, 2) }}</span>
            <b>{{ state?.opponent }}</b>
            <span class="faint">{{ mySide === 'BLUE' ? 'Red side' : 'Blue side' }}</span>
          </div>
        </div>
        <p class="lobby__side">
          {{ mySide === 'BLUE' ? 'You have first ban and first pick.' : 'You have the last pick.' }}
        </p>
        <p class="lobby__count num">{{ Math.ceil(lobbyLeft) }}</p>
        <p class="lobby__note faint">
          <template v-if="state?.isBot">Nobody was searching, so the agent takes the other side.</template>
          <template v-else>{{ opponentHere ? 'They are here.' : 'Waiting for them to load…' }}</template>
          Bans open in a moment; nobody's clock is running yet.
        </p>
      </section>

      <!-- ===== The shared watch, and then the result ============================ -->
      <template v-else-if="(phase === 'WATCH' || phase === 'RESULT') && state?.result">
        <p v-if="phase === 'WATCH'" class="notice notice--live">
          You are both watching this live: same clock, same second.
        </p>
        <MatchWatch
          :result="state.result"
          :clock="watchAt"
          :blue-name="blueName"
          :red-name="redName"
          :my-side="mySide"
          :show-result="phase === 'RESULT'"
        :seekable="phase === 'RESULT'"
          result-first
        @seek="seek"
        >
          <template v-if="phase === 'RESULT'" #controls>
            <ReplayTransport
              ref="transport"
              v-model:clock="rewatchClock"
              :length="matchEnd(state.result)"
              :initial-speed="4"
              :skip="rewatch !== null"
            />
          </template>
        </MatchWatch>
        <!-- What the match paid. docs/01 section 5. -->
        <section v-if="phase === 'RESULT' && payout" class="payout">
          <header class="payout__top">
            <p class="label">Paid out</p>
            <b class="payout__total tnum">
              <i class="coin coin--s" aria-hidden="true" />+{{ payout.credits.toLocaleString('en') }}
            </b>
          </header>

          <ul class="payout__lines">
            <li v-for="(line, n) in payoutLines" :key="`m${n}`">
              <span>{{ line.label }}</span>
              <b class="tnum">{{ line.credits }}</b>
            </li>
            <li v-for="s in sponsorLines" :key="s.key" class="payout__sponsor">
              <span>
                {{ s.name }}
                <i class="payout__terms" :class="{ 'is-met': s.met }">{{ s.demand }}</i>
              </span>
              <b class="tnum">{{ s.credits }}</b>
            </li>
          </ul>

          <p v-if="payout.detail?.creditsWithheld" class="payout__note">
            Today's Ghost allowance is spent, so this one paid card XP only.
          </p>

          <p v-if="xpSpread" class="payout__note">
            <strong>+{{ xpSpread.base }} XP</strong> to each of your five<template
              v-for="a in xpSpread.standout" :key="a.name"
            >, <strong>+{{ a.xp }}</strong> to {{ a.name }} ({{ a.grade }})</template>.
          </p>
        </section>

        <div v-if="phase === 'RESULT'" class="again">
          <NuxtLink v-if="state.source === 'LEAGUE'" class="btn btn--ghost btn--lg" to="/leagues">League table</NuxtLink>
          <NuxtLink class="btn btn--lg" to="/duels">Battle again</NuxtLink>
        </div>
      </template>

      <!-- The draft finished but the result has not arrived on this client yet. -->
      <section v-else-if="phase === 'WATCH' || phase === 'RESULT'" class="lobby">
        <p class="lobby__state"><i aria-hidden="true" />Drafted</p>
        <p class="lobby__note">Both fives are in. Loading the match…</p>
      </section>

      <!-- ===== The draft ======================================================= -->
      <template v-else-if="state && phase === 'DRAFT'">
        <section class="turn" :class="{ 'is-mine': state.myTurn }">
          <div>
            <p class="turn__who" aria-live="polite">
              <template v-if="state.myTurn">Your {{ isPick ? 'pick' : 'ban' }}</template>
              <template v-else-if="theirHover">{{ state.opponent }} eyes {{ theirHover.championName }}</template>
              <template v-else>{{ state.opponent }} is {{ isPick ? 'picking' : 'banning' }}</template>
            </p>
            <p class="turn__phase">
              {{ state.step ? PHASE_LABEL[state.step.phase] : 'Draft' }} · step {{ Math.min((state.turn ?? 0) + 1, 20) }} of 20
            </p>
          </div>
          <div class="timer" :class="{ 'is-low': lowTime }">
            <b class="num">{{ secondsLeft ?? '—' }}</b>
            <span class="timer__bar"><i :style="{ width: `${timerShare}%` }" /></span>
          </div>
        </section>

        <div class="seq" aria-hidden="true">
          <i v-for="s in seq" :key="s.i" :class="[s.side, s.state, { ban: s.ban }]" />
        </div>

        <!-- the board, laid out like the broadcast: blue left, red right -->
        <section class="board">
          <div v-for="side in ['BLUE', 'RED']" :key="side" class="col" :class="`col--${side.toLowerCase()}`">
            <div class="col__head">
              <b>{{ nameOf(side) }}</b>
              <span class="bans">
                <span v-for="n in 5" :key="n" class="ban" :class="{ 'is-empty': !sideActions(side, 'BAN')[n - 1] }">
                  <img
                    v-if="sideActions(side, 'BAN')[n - 1]"
                    :src="art(sideActions(side, 'BAN')[n - 1].championKey)"
                    :alt="`${sideActions(side, 'BAN')[n - 1].championName} banned`"
                  >
                </span>
              </span>
            </div>

            <ul class="picks">
              <li
                v-for="slot in SLOTS" :key="slot"
                class="pick"
                :class="{
                  'is-empty': !pickFor(side, slot) && !(theirHover && theirHover.kind === 'PICK' && theirHover.side === side && theirHover.slot === slot),
                  'is-hover': !pickFor(side, slot) && theirHover && theirHover.kind === 'PICK' && theirHover.side === side && theirHover.slot === slot,
                  'is-auto': pickFor(side, slot)?.auto,
                }"
              >
                <img v-if="pickFor(side, slot)" :src="splash(pickFor(side, slot).championKey)" alt="" class="pick__art" loading="lazy">
                <img
                  v-else-if="theirHover && theirHover.kind === 'PICK' && theirHover.side === side && theirHover.slot === slot"
                  :src="splash(theirHover.championKey)" alt="" class="pick__art"
                >
                <span class="pick__text">
                  <b>{{ lineupOf(side)[slot]?.name || '—' }}</b>
                  <span v-if="pickFor(side, slot)">{{ pickFor(side, slot).championName }}<template v-if="pickFor(side, slot).auto"> · auto</template></span>
                  <span v-else class="faint">Waiting</span>
                </span>
                <span class="pick__n">
                  <template v-if="pickIndex(side, slot)">{{ side === 'BLUE' ? 'B' : 'R' }}{{ pickIndex(side, slot) }}</template>
                  <template v-else>{{ slot }}</template>
                </span>
              </li>
            </ul>
          </div>
        </section>

        <!-- choose a slot before picking -->
        <section v-if="state.myTurn && isPick" class="slotpick">
          <p class="slotpick__label">Into</p>
          <div class="seg">
            <button
              v-for="slot in openSlots" :key="slot" type="button"
              :aria-pressed="chosenSlot === slot"
              @click="chosenSlot = chosenSlot === slot ? null : slot"
            >{{ slot }}</button>
          </div>
          <p class="faint slotpick__note">Unchosen, it goes to whichever open slot has the most mastery on it.</p>
        </section>

        <!-- the pool -->
        <section class="pool">
          <div class="pool__head">
            <p class="pool__count">Champions <span class="faint tnum">{{ pool.filter(c => !taken.has(c.key)).length }} left</span></p>
            <input v-model="search" class="input pool__search" type="search" placeholder="Search champions" aria-label="Search champions">
            <div class="seg pool__view" role="group" aria-label="Show champions">
              <button type="button" :aria-pressed="poolView === 'mine'" @click="setPoolView('mine')">Your pools</button>
              <button type="button" :aria-pressed="poolView === 'theirs'" @click="setPoolView('theirs')">Theirs</button>
              <button type="button" :aria-pressed="poolView === 'all'" @click="setPoolView('all')">All</button>
            </div>
          </div>
          <p v-if="!champions.length" class="pool__none faint">
            <template v-if="search">No champion matches “{{ search }}”.</template>
            <template v-else-if="poolView === 'mine'">Nothing left in your open slots' pools. Try All.</template>
            <template v-else>Nothing left in their pools. Try All.</template>
          </p>
          <ul class="pool__grid">
            <li v-for="c in champions" :key="c.key">
              <button
                class="champ"
                :class="{ 'is-gone': c.gone, 'is-sel': selected?.key === c.key }"
                type="button"
                :disabled="c.gone || !state.myTurn || busy"
                :title="c.name"
                @click="consider({ key: c.key, name: c.name })"
              >
                <img :src="art(c.key)" :alt="c.name" loading="lazy">
                <span class="champ__name">{{ c.name }}</span>
                <span
                  v-if="!c.gone && (poolView === 'theirs' || (!isPick && poolView !== 'mine') ? c.theirs : c.mine) > 0"
                  class="champ__m tnum"
                  :class="{ 'is-theirs': poolView === 'theirs' || (!isPick && poolView !== 'mine') }"
                >
                  {{ poolView === 'theirs' || (!isPick && poolView !== 'mine') ? c.theirs : c.mine }}
                </span>
              </button>
            </li>
          </ul>
        </section>

        <!-- what you are about to do, and the commit -->
        <section v-if="state.myTurn" class="lockbar">
          <img v-if="selected" :src="art(selected.key)" :alt="selected.name" class="lockbar__art">
          <span v-else class="lockbar__hole" aria-hidden="true" />
          <p class="lockbar__text">
            <template v-if="selected">
              <b>{{ isPick ? `${selected.name} to ${lineupOf(mySide || 'BLUE')[chosenSlot || bestSlotFor(selected.key) || 'MID']?.name || 'your five'}` : `Ban ${selected.name}` }}</b>
              <span v-if="isPick">into {{ chosenSlot || bestSlotFor(selected.key) }} · mastery {{ masteryOn(myLineup, (chosenSlot || bestSlotFor(selected.key)) as Slot, selected.key) }}</span>
              <span v-else>Gone for both sides</span>
            </template>
            <template v-else>
              <b>Choose a champion</b>
              <span>Tap one, then lock it in</span>
            </template>
          </p>
          <button class="btn lockbar__go" type="button" data-sound="none" :disabled="!selected || busy" @click="lockIn">
            {{ busy ? 'Locking' : isPick ? 'Lock in' : 'Ban' }}
          </button>
        </section>
      </template>

      <!-- A challenge that was never answered, or one that was withdrawn. -->
      <section v-else-if="state" class="lobby">
        <p class="lobby__state lobby__state--quiet">{{ phase === 'PENDING' ? 'Waiting' : 'Over' }}</p>
        <p class="lobby__note">
          <template v-if="phase === 'PENDING'">This challenge has not been answered yet.</template>
          <template v-else>This duel never started.</template>
        </p>
        <NuxtLink class="btn btn--ghost" to="/duels">Back to Battle</NuxtLink>
      </section>
    </div>
  </main>
</template>

<style scoped>
.room { min-height: 100svh; background: var(--bg-0); }
.room.has-lock { padding-bottom: 92px; }

.room__bar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  height: calc(52px + env(safe-area-inset-top, 0px));
  padding: env(safe-area-inset-top, 0px) 12px 0 4px;
  background: rgba(4, 7, 13, 0.92);
  border-bottom: 1px solid var(--line-1);
  backdrop-filter: blur(12px);
}
.room__vs { margin: 0; font-size: 14px; color: var(--ink-2); text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.room__vs b { color: var(--ink-1); font-weight: 680; }

.room__body { max-width: 1240px; margin: 0 auto; padding: 0 0 24px; }
.room__body > .notice { margin: 12px 16px; }
.room__skeleton { height: 60vh; margin: 16px; }

/* --- lobby ------------------------------------------------------------------ */
.lobby { display: grid; justify-items: center; gap: 12px; padding: 48px 16px; text-align: center; }
.lobby__state { display: inline-flex; align-items: center; gap: 8px; margin: 0; font-size: 13px; font-weight: 650; color: var(--teal-1); }
.lobby__state i { width: 7px; height: 7px; background: var(--teal-2); transform: rotate(45deg); }
.lobby__state--quiet { color: var(--ink-3); }
.lobby__vs { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 18px; width: min(100%, 460px); margin-top: 8px; }
.lobby__who { display: grid; justify-items: center; gap: 6px; }
.lobby__who b { font-size: 16px; font-weight: 700; }
.lobby__who .faint { font-size: 12.5px; }
.lobby__avatar { display: grid; place-items: center; width: 64px; height: 64px; border-radius: 50%; background: var(--bg-3); font-weight: 780; font-size: 15px; text-transform: uppercase; }
.lobby__who.is-blue .lobby__avatar { box-shadow: 0 0 0 2px var(--blue); }
.lobby__who.is-red .lobby__avatar { box-shadow: 0 0 0 2px var(--red); }
.lobby__x { font-stretch: 75%; font-weight: 860; font-size: 30px; color: var(--ink-3); }
.lobby__side { margin: 0; font-size: 14px; color: var(--ink-2); }
.lobby__count { margin: 8px 0 0; font-size: 72px; }
.lobby__note { margin: 0; max-width: 36ch; font-size: 13px; }

.again { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; padding: 20px 0 0; }
.room--watch .room__body, .room--result .room__body { padding: 0 16px 24px; }

/* The receipt. Lines that paid nothing are still lines: a zero that is explained reads
   better than a total that cannot be reconciled with what was just watched. */
.payout {
  margin: 14px auto 0;
  max-width: 520px;
  padding: 12px 14px;
  border: 1px solid rgba(216, 176, 100, 0.26);
  border-radius: var(--radius);
  background: var(--bg-2);
}
.payout__top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.payout__total { display: inline-flex; align-items: center; gap: 4px; font-size: 18px; }
.payout__lines { margin: 8px 0 0; padding: 0; list-style: none; font-size: 13.5px; }
.payout__lines li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.payout__lines li:first-child { border-top: 0; }
.payout__sponsor span { display: flex; flex-direction: column; }
.payout__terms {
  color: var(--ink-2);
  font-size: 11.5px;
  font-style: normal;
}
.payout__terms.is-met { color: #7fc29a; }
.payout__terms.is-met::after { content: ' · met'; }
.payout__note { margin: 8px 0 0; color: var(--ink-2); font-size: 12.5px; }
.room--watch .notice { margin: 12px 0; }

/* --- the draft ---------------------------------------------------------------- */
.turn { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px 16px; background: var(--bg-2); }
.turn.is-mine { background: linear-gradient(90deg, rgba(31, 207, 193, 0.14), rgba(31, 207, 193, 0.02) 70%); }
.turn__who { margin: 0; font-stretch: 80%; font-weight: 840; font-size: 24px; line-height: 1.05; text-transform: uppercase; }
.turn.is-mine .turn__who { color: var(--teal-1); }
.turn__phase { margin: 3px 0 0; font-size: 12.5px; color: var(--ink-3); }
.timer { display: grid; justify-items: end; gap: 7px; min-width: 64px; }
.timer b { font-size: 44px; line-height: 0.85; }
.timer__bar { display: block; width: 64px; height: 3px; background: var(--bg-4); }
.timer__bar i { display: block; height: 100%; background: var(--teal-2); transition: width 0.2s linear; }
.timer.is-low b { color: var(--warn-2); }
.timer.is-low .timer__bar i { background: var(--warn-2); }

.seq { display: grid; grid-template-columns: repeat(20, 1fr); gap: 2px; padding: 9px 16px 11px; background: var(--bg-2); border-bottom: 1px solid var(--line-1); }
.seq i { height: 4px; background: var(--bg-4); }
.seq i.done.b { background: rgba(74, 144, 255, 0.6); }
.seq i.done.r { background: rgba(240, 80, 95, 0.6); }
.seq i.ban { opacity: 0.6; }
.seq i.now { background: var(--teal-2); opacity: 1; height: 6px; margin-top: -1px; }

.board { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 12px 10px 0; }
.col { display: grid; gap: 4px; align-content: start; }
.col__head { display: flex; justify-content: space-between; align-items: center; gap: 6px; margin-bottom: 4px; }
.col__head b { font-size: 12.5px; font-weight: 720; }
.col--blue .col__head b { color: var(--blue-2); }
.col--red .col__head { flex-direction: row-reverse; }
.col--red .col__head b { color: var(--red-2); }
.bans { display: flex; gap: 3px; }
.col--red .bans { flex-direction: row-reverse; }
.ban { position: relative; width: 22px; height: 22px; overflow: hidden; border-radius: 2px; background: var(--bg-3); box-shadow: inset 0 0 0 1px var(--line-1); }
.ban img { width: 100%; height: 100%; object-fit: cover; filter: grayscale(1) brightness(0.7); }
.ban:not(.is-empty)::after { content: ''; position: absolute; left: -20%; right: -20%; top: 50%; height: 1.5px; background: rgba(240, 80, 95, 0.9); transform: rotate(-45deg); }

.picks { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.pick { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; height: 48px; padding: 6px 9px; overflow: hidden; background: var(--bg-2); border-radius: 2px; }
.col--blue .pick { box-shadow: inset 2px 0 0 var(--blue); }
.col--red .pick { box-shadow: inset -2px 0 0 var(--red); grid-template-columns: auto minmax(0, 1fr); text-align: right; }
.col--red .pick__n { order: -1; }
.pick__art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: 50% 20%; }
.pick:not(.is-empty)::after { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, rgba(5, 8, 13, 0.92), rgba(5, 8, 13, 0.25)); }
.col--red .pick:not(.is-empty)::after { background: linear-gradient(270deg, rgba(5, 8, 13, 0.92), rgba(5, 8, 13, 0.25)); }
.pick > span { position: relative; z-index: 1; min-width: 0; }
.pick__text b { display: block; font-stretch: 85%; font-weight: 760; font-size: 13.5px; line-height: 1.15; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pick__text span { display: block; font-size: 11.5px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pick__n { font-stretch: 112%; font-size: 10.5px; font-weight: 760; letter-spacing: 0.1em; color: var(--ink-3); }
.pick.is-empty { box-shadow: inset 0 0 0 1px var(--line-1) !important; }
.pick.is-hover { box-shadow: inset 0 0 0 1.5px var(--teal-2) !important; }
.pick.is-hover .pick__art { opacity: 0.45; filter: saturate(0.6); }
.pick.is-auto .pick__text span { color: var(--warn-2); }

.slotpick { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 10px; padding: 14px 16px 0; }
.slotpick__label { margin: 0; font-size: 13px; color: var(--ink-3); }
.slotpick__note { grid-column: 1 / -1; margin: 0; font-size: 12px; }

.pool { padding: 16px 16px 0; }
.pool__head { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 12px; margin-bottom: 12px; }
.pool__count { margin: 0; font-size: 13.5px; font-weight: 650; }
.pool__search { min-height: 42px; font-size: 15px; }
.pool__view { grid-column: 1 / -1; }
.pool__none { margin: 4px 0 12px; font-size: 14px; }
.champ__m.is-theirs { color: var(--red-2); }
.pool__grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(58px, 1fr)); gap: 10px 8px; }
.champ { position: relative; display: grid; gap: 4px; justify-items: center; width: 100%; padding: 0; border: 0; background: none; color: inherit; cursor: pointer; }
.champ img { width: 100%; aspect-ratio: 1; border-radius: 3px; box-shadow: inset 0 0 0 1px var(--line-2); }
.champ__name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 600; color: var(--ink-2); }
.champ__m { position: absolute; top: 3px; right: 3px; min-width: 22px; padding: 1px 3px; border-radius: 2px; background: rgba(4, 7, 13, 0.88); font-size: 11px; font-weight: 800; color: var(--gold-1); text-align: center; }
.champ:disabled { cursor: default; }
.champ.is-gone img { filter: grayscale(1) brightness(0.35); }
.champ.is-gone .champ__name { color: var(--ink-4); }
.champ.is-sel img { box-shadow: 0 0 0 2px var(--teal-2); }
.champ.is-sel .champ__name { color: var(--teal-1); }

.lockbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 30;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 10px 16px calc(10px + env(safe-area-inset-bottom, 0px));
  background: rgba(4, 7, 13, 0.97);
  border-top: 1px solid var(--line-2);
}
.lockbar__art { width: 44px; height: 44px; border-radius: 3px; box-shadow: 0 0 0 1.5px var(--teal-2); }
.lockbar__hole { width: 44px; height: 44px; border: 1px dashed var(--line-3); border-radius: 3px; }
.lockbar__text { margin: 0; min-width: 0; }
.lockbar__text b { display: block; font-size: 14px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lockbar__text span { display: block; font-size: 12px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* --- desktop: two sides facing a central stage ---------------------------------- */
@media (min-width: 1024px) {
  .room__body { padding: 0 32px 32px; }
  .turn { margin-top: 16px; padding: 16px 24px; border-radius: var(--radius); }
  .turn__who { font-size: 32px; }
  .timer b { font-size: 60px; }
  .timer__bar { width: 96px; }
  .seq { padding: 10px 0 14px; background: none; border: 0; }
  .room--draft .room__body { display: grid; grid-template-columns: 300px minmax(0, 1fr) 300px; grid-template-areas: 'turn turn turn' 'seq seq seq' 'blue pool red' 'blue slot red'; column-gap: 24px; align-items: start; }
  .turn { grid-area: turn; }
  .seq { grid-area: seq; }
  .board { display: contents; }
  .col--blue { grid-area: blue; }
  .col--red { grid-area: red; }
  .pick { height: 92px; padding: 10px 14px; }
  .pick__text b { font-size: 16px; }
  .pick__text span { font-size: 12.5px; }
  .ban { width: 30px; height: 30px; }
  .col__head b { font-size: 15px; }
  .pool { grid-area: pool; padding: 16px; background: var(--bg-1); border: 1px solid var(--line-1); border-radius: var(--radius); }
  .pool__grid { grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); max-height: 60vh; overflow: auto; }
  .slotpick { grid-area: slot; padding: 14px 0 0; }
  .lockbar { left: 50%; right: auto; bottom: 20px; width: min(640px, calc(100vw - 680px)); transform: translateX(-50%); border: 1px solid var(--line-2); border-radius: var(--radius); padding: 10px 14px; }
}

@media (prefers-reduced-motion: reduce) { .timer__bar i { transition: none; } }
</style>
