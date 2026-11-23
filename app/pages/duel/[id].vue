<script setup lang="ts">
import { splashUrl, squareUrl } from '@lom/card-engine';
import { SLOTS, PHASE_LABEL, DRAFT_ORDER, ACTION_SECONDS, upcoming, type Slot } from '~~/shared/draft';
import { DIFFICULTY_LABEL, asDifficulty } from '~~/shared/duelRoom';

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
 */

const route = useRoute();
const id = route.params.id as string;

const {
  state, pool, error: roomError, loading, reconnecting,
  phase, matchClock, secondsLeft, turnClock, lobbyLeft,
  theirHover, opponentHere, sendHover, saveSelection, resync,
} = useDuelRoom(id);

const actionError = ref('');
const busy = ref(false);
const search = ref('');
const chosenSlot = ref<Slot | null>(null);
const selected = ref<{ key: string; name: string } | null>(null);

const error = computed(() => actionError.value || roomError.value);

const mySide = computed(() => state.value?.side);
const theirSide = computed(() => (state.value?.side === 'BLUE' ? 'RED' : 'BLUE'));
const isPick = computed(() => state.value?.step?.kind === 'PICK');

/**
 * Which champions the grid shows. A pick wants yours, the champions your open slots know
 * best; a ban wants theirs, the ones their open slots would play. "All" is the full list.
 *
 * It follows the step on every new step, unless the person changed it during that step. It
 * used to follow only until the first time they touched it, and from then on stayed wherever
 * they had left it for the rest of the draft — so a player who looked at All once during a
 * ban found themselves picking from All, and their own pools nowhere in sight.
 */
type PoolView = 'mine' | 'theirs' | 'all';
const poolView = ref<PoolView>('mine');
const poolViewChosen = ref(false);
function setPoolView(v: PoolView) {
  poolView.value = v;
  poolViewChosen.value = true;
}

/**
 * A new turn, or a turn that is not ours, invalidates whatever was being considered — and
 * puts back a selection the server is holding for this step, so a reload mid-turn does not
 * empty the player's hand.
 */
watch(() => [state.value?.turn, state.value?.myTurn], () => {
  selected.value = null;
  chosenSlot.value = null;
  actionError.value = '';
  poolViewChosen.value = false;
  poolView.value = isPick.value ? 'mine' : 'theirs';

  const held = state.value?.myHover;
  if (held && state.value?.myTurn) {
    selected.value = { key: held.championKey, name: held.championName };
    chosenSlot.value = (held.slot as Slot | null) ?? null;
  }
}, { immediate: true });

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

const poolByKey = computed(() => new Map(pool.value.map((c) => [c.key, c])));

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

/** Which number a champion tile shows: theirs when looking at theirs or banning, else mine. */
const showsTheirs = computed(() => poolView.value === 'theirs' || (!isPick.value && poolView.value !== 'mine'));

/** What each of my cards would be worth on this champion — the reason to pick it. */
function masteryOn(lineup: any, slot: Slot, championKey: string): number {
  return lineup?.[slot]?.pool?.[championKey] ?? 0;
}

/**
 * Where an unslotted pick goes.
 *
 * The open slot with the most mastery on it; failing that, the lane the champion is actually
 * played in, if that lane is open; failing that, the only open slot if there is only one.
 * Otherwise nowhere — the player is asked. It used to fall through to the first open slot,
 * which is how an off-pool champion landed silently on TOP.
 */
function bestSlotFor(championKey: string): Slot | null {
  let best: Slot | null = null;
  let top = 0;
  for (const slot of openSlots.value) {
    const m = masteryOn(myLineup.value, slot, championKey);
    if (m > top) { top = m; best = slot; }
  }
  if (best) return best;
  const roles = (poolByKey.value.get(championKey)?.roles || []) as string[];
  for (const r of roles) {
    if (openSlots.value.includes(r as Slot)) return r as Slot;
  }
  return openSlots.value.length === 1 ? openSlots.value[0]! : null;
}

const targetSlot = computed<Slot | null>(() => {
  if (!isPick.value || !selected.value) return null;
  return chosenSlot.value || bestSlotFor(selected.value.key);
});

/** The card that would play the selected champion, and how well. */
const targetCard = computed(() => (targetSlot.value ? myLineup.value[targetSlot.value] : null));
const targetMastery = computed(() =>
  targetSlot.value && selected.value ? masteryOn(myLineup.value, targetSlot.value, selected.value.key) : 0);

/** Tell the other side what is in my hand, and save it so the clock honours it. */
function announce() {
  const s = state.value;
  if (!s?.myTurn) return;
  const slot = isPick.value && selected.value ? targetSlot.value : null;
  sendHover(selected.value
    ? {
      side: s.side!,
      kind: s.step.kind,
      turn: s.turn,
      championKey: selected.value.key,
      championName: selected.value.name,
      slot,
    }
    : null);
  saveSelection({ turn: s.turn, championKey: selected.value?.key ?? null, slot });
}

/**
 * Tapping a champion considers it; locking it in commits.
 *
 * Two steps, as the real client does and docs/05 section 3.3 describes. A single tap
 * committing is unforgiving on a phone — a mis-tap spends a ban — and it also leaves the
 * opponent with nothing to watch until the action is already over.
 *
 * The consideration is also saved to the server. If the clock runs out with a champion in
 * hand, that champion is what locks, not one the agent makes up.
 */
function consider(c: { key: string; name: string }, slot?: Slot) {
  if (!state.value?.myTurn || busy.value || phase.value !== 'DRAFT') return;
  selected.value = c;
  if (slot) chosenSlot.value = slot;
  actionError.value = '';
  announce();
}

// Moving the slot while a champion is already in hand is a change the other side should see.
watch(chosenSlot, () => {
  if (!selected.value || !state.value?.myTurn || !isPick.value) return;
  announce();
});

async function lockIn() {
  if (busy.value || !state.value?.myTurn || !selected.value) return;
  const slot = isPick.value ? targetSlot.value : null;
  if (isPick.value && !slot) {
    actionError.value = `Nobody in your five plays ${selected.value.name}. Choose a slot for it.`;
    return;
  }
  busy.value = true;
  try {
    await $fetch(`/api/duel/${id}/action`, {
      method: 'POST',
      // The step this was meant for. The server refuses it by name if the draft has moved on.
      body: { championKey: selected.value.key, slot, turn: state.value.turn },
    });
    selected.value = null;
    chosenSlot.value = null;
    search.value = '';
    sendHover(null);
    // No reload: the insert is pushed to both clients, including this one.
  } catch (e: any) {
    actionError.value = e?.data?.statusMessage || e?.message || 'That did not go through.';
    // Whatever went wrong, the screen is now behind the draft. Catch it up for real.
    if (e?.statusCode === 409 || e?.status === 409) await resync();
  } finally {
    busy.value = false;
  }
}

// --- the agent's advice ---------------------------------------------------------------
/**
 * What the agent would do in my seat (/api/duel/[id]/suggest): the same scoring it drafts
 * with, without its dice. Fetched once per step of mine.
 */
const advice = ref<any>(null);
watch(() => [state.value?.turn, state.value?.myTurn, phase.value], async () => {
  const s = state.value;
  if (!s?.myTurn || phase.value !== 'DRAFT') return;
  if (advice.value?.turn === s.turn) return;
  try {
    advice.value = await $fetch(`/api/duel/${id}/suggest`);
  } catch {
    advice.value = null;
  }
}, { immediate: true });

const adviceSlot = computed<Slot | null>(() => {
  const a = advice.value;
  if (!a || a.kind !== 'PICK' || a.turn !== state.value?.turn) return null;
  return chosenSlot.value || targetSlot.value || a.best || null;
});
const pickTips = computed(() => {
  const slot = adviceSlot.value;
  if (!slot) return [];
  return (advice.value?.bySlot?.[slot] || []).filter((t: any) => !taken.value.has(t.championKey));
});
const banTips = computed(() => {
  const a = advice.value;
  if (!a || a.kind !== 'BAN' || a.turn !== state.value?.turn) return [];
  return (a.bans || []).filter((t: any) => !taken.value.has(t.championKey));
});

// --- the order ------------------------------------------------------------------------
const order = computed(() => upcoming(state.value?.turn ?? 0, mySide.value));
const sideWord = (s: string) => (s === mySide.value ? 'You' : s === 'BLUE' ? 'Blue' : 'Red');
const nextLine = computed(() => {
  const n = order.value.next;
  if (!n) return 'Last step of the draft';
  return `Next: ${sideWord(n.side)} ${n.kind === 'BAN' ? 'ban' : 'pick'}${n.count > 1 ? ` ×${n.count}` : ''}`;
});
const mineLine = computed(() => {
  const k = order.value.stepsUntilMine;
  if (k === null) return 'You are done';
  if (k === 0) return 'Your turn now';
  return k === 1 ? 'You are up next' : `You in ${k} steps`;
});
const bonusLine = computed(() => (state.value?.step?.side === mySide.value
  ? 'At 0, your selection locks or the agent picks'
  : 'At 0, the agent picks for them'));
const seqLabel = computed(() => {
  const t = Math.min((state.value?.turn ?? 0) + 1, 20);
  const step = state.value?.step;
  const now = step ? `${sideWord(step.side)} ${step.kind === 'BAN' ? 'ban' : 'pick'}` : '';
  return `Draft order, step ${t} of 20${now ? `: ${now}` : ''}. ${nextLine.value}. ${mineLine.value}.`;
});

// --- the clock ------------------------------------------------------------------------
const myBonus = computed(() => {
  const s = state.value;
  if (!s?.side) return 0;
  // While my pool is staked behind this action it is the live countdown, not a reserve.
  if (s.step?.side === s.side && turnClock.value?.inBonus) return turnClock.value.bonus;
  const staked = s.bonus?.staked?.side === s.side ? Number(s.bonus.staked.amount) || 0 : 0;
  return staked || Number(s.bonus?.[s.side] ?? 0);
});
const stakedPool = computed(() => {
  const s = state.value;
  const side = s?.step?.side;
  if (!side) return 0;
  return s?.bonus?.staked?.side === side ? Number(s.bonus.staked.amount) || 0 : Number(s?.bonus?.[side] ?? 0);
});

/** How much of the clock is left, for the draining bar: the 30 seconds, then the bonus pool. */
const timerShare = computed(() => {
  const tc = turnClock.value;
  if (!tc) return 0;
  const share = tc.inBonus ? tc.bonus / Math.max(1, stakedPool.value) : tc.main / ACTION_SECONDS;
  return Math.max(0, Math.min(100, share * 100));
});
const lowTime = computed(() => (secondsLeft.value ?? 99) <= 10);
const inBonus = computed(() => Boolean(turnClock.value?.inBonus));

// --- the board ------------------------------------------------------------------------
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

const hoverOn = (side: string, slot: Slot) =>
  Boolean(!pickFor(side, slot) && theirHover.value && theirHover.value.kind === 'PICK'
    && theirHover.value.side === side && theirHover.value.slot === slot);

const lineupOf = (side: string) =>
  (side === 'BLUE' ? state.value?.blueLineup : state.value?.redLineup) || {};

const nameOf = (side: string) => {
  if (side === mySide.value) return 'You';
  // A league fixture has seat names; someone watching it has no "you" in it at all.
  const seat = (state.value as any)?.teamNames?.[side];
  if (!mySide.value && seat) return seat;
  return state.value?.opponent || 'Opponent';
};
const spectating = computed(() => Boolean((state.value as any)?.spectating));

/** The lobby clock reads like a clock once it is longer than a few seconds (a league lobby is 15 minutes). */
const lobbyText = computed(() => {
  const t = Math.max(0, Math.ceil(lobbyLeft.value));
  if (t < 60) return String(t);
  const m = Math.floor(t / 60);
  return m + ':' + String(t % 60).padStart(2, '0');
});

/** League fixtures: "start as soon as we are both here". The draft otherwise waits for kick-off. */
const fixture = computed(() => (state.value as any)?.fixture || null);
const iAmReady = computed(() => {
  const f = fixture.value;
  if (!f || !mySide.value) return false;
  return mySide.value === 'BLUE' ? f.blueReady : f.redReady;
});
const readyBusy = ref(false);
async function toggleReady() {
  const f = fixture.value;
  if (!f || readyBusy.value) return;
  readyBusy.value = true;
  try {
    await $fetch(`/api/league/${f.leagueId}/fixture/${f.id}/ready`, { method: 'POST', body: { ready: !iAmReady.value } });
    f[mySide.value === 'BLUE' ? 'blueReady' : 'redReady'] = !iAmReady.value;
  } catch (e: any) {
    actionError.value = e?.data?.statusMessage || e?.statusMessage || 'Could not reach the league.';
  } finally {
    readyBusy.value = false;
  }
}

/** The composition panel, per side: mine with the modifier, theirs as tags only. */
const compOf = (side: string) =>
  (side === mySide.value ? state.value?.composition?.mine : state.value?.composition?.theirs) || null;

/** Names for the scoreboard during the watch, in blue/red order rather than mine/theirs. */
const blueName = computed(() => nameOf('BLUE'));
const redName = computed(() => nameOf('RED'));

/**
 * A finished match can be rewatched. The rewatch clock is this client's alone, so it is
 * only offered once both players are past the shared watch; until it is touched the result
 * shows its last frame — the last event, not `gameLength`, so the nexus is on screen.
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

// --- leaving ----------------------------------------------------------------------------
/**
 * The X asks first while the draft is live. Leaving does not forfeit — the agent plays your
 * turns from the moment your clock runs out — but it is one tap from a mis-tap to watching
 * your draft be played by somebody else.
 */
function leave() {
  if ((phase.value === 'DRAFT' || phase.value === 'LOBBY')
    && !window.confirm('Leave the draft? It carries on without you: when your clock runs out, the agent plays your turn.')) {
    return;
  }
  navigateTo('/duels');
}

// --- rematch ------------------------------------------------------------------------------
/**
 * Again, with the same person or the same setup.
 *
 * A friendly re-challenges the same manager; a queue match goes back in the queue; practice
 * starts another practice at the same difficulty. A league fixture has no rematch — the
 * table decides who plays whom.
 */
const rematchBusy = ref(false);
const rematchNote = ref('');
const rematchLabel = computed(() => {
  const s = state.value;
  if (!s) return null;
  if (s.source === 'BOT') return `Practice again · ${DIFFICULTY_LABEL[asDifficulty(s.difficulty)]}`;
  if (s.source === 'QUEUE') return 'Queue again';
  if (s.source === 'CHALLENGE' && s.opponentId) return `Rematch ${s.opponent}`;
  return null;
});
async function rematch() {
  const s = state.value;
  if (!s || rematchBusy.value) return;
  rematchBusy.value = true;
  rematchNote.value = '';
  try {
    if (s.source === 'QUEUE') return await navigateTo('/duels?battle=1');
    if (s.source === 'BOT') {
      const res = await $fetch<any>('/api/duel/queue/bot', {
        method: 'POST',
        body: { difficulty: asDifficulty(s.difficulty) },
      });
      if (res?.duelId) return await navigateTo(`/duel/${res.duelId}`);
      return;
    }
    const res = await $fetch<any>('/api/duel/challenge', { method: 'POST', body: { opponentId: s.opponentId } });
    if (res?.accepted && res.duelId) return await navigateTo(`/duel/${res.duelId}`);
    rematchNote.value = `Challenge sent to ${s.opponent}. It starts when they accept.`;
  } catch (e: any) {
    rematchNote.value = e?.data?.statusMessage || e?.message || 'That did not go through.';
  } finally {
    rematchBusy.value = false;
  }
}

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

// --- keyboard -------------------------------------------------------------------------
/**
 * Enter locks in, on a device with a real keyboard. Not on a phone: there Enter is the
 * search field's "go" key, and a ban spent by dismissing the keyboard is a ban lost.
 */
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.isComposing || e.repeat) return;
  if (phase.value !== 'DRAFT' || !state.value?.myTurn || !selected.value || busy.value) return;
  const target = e.target as HTMLElement | null;
  if (target && target.closest('button, a, textarea, select')) return;
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  e.preventDefault();
  lockIn();
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

useHead(() => ({
  // The tab title carries the turn, for a draft left in a background tab.
  title: phase.value === 'DRAFT' && state.value?.myTurn ? `Your ${isPick.value ? 'pick' : 'ban'} — LOM` : 'Duel — LOM',
}));
</script>


<template>
  <main class="room" :class="[`room--${(phase || 'loading').toLowerCase()}`, { 'has-lock': phase === 'DRAFT' && state?.myTurn }]">
    <header class="room__bar">
      <button class="icon-btn" type="button" aria-label="Leave the room" @click="leave">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
      <p class="room__vs">
        <template v-if="phase === 'LOBBY'">Match found</template>
        <template v-else-if="phase === 'DRAFT'">Draft</template>
        <template v-else-if="phase === 'WATCH'">Live</template>
        <template v-else>Result</template>
        <span class="faint"> vs </span><b>{{ state?.opponent || '…' }}</b>
        <template v-if="state && !state.isBot && (phase === 'LOBBY' || phase === 'DRAFT' || phase === 'WATCH')">
          <span class="presence" :class="{ 'is-here': opponentHere }" aria-hidden="true" />
          <span class="sr-only">{{ opponentHere ? ', in the room' : ', not in the room' }}</span>
          <span v-if="!opponentHere && phase === 'DRAFT'" class="faint presence__away"> · away</span>
        </template>
        <span v-if="reconnecting" class="faint room__reconnect"> · reconnecting</span>
      </p>
      <span v-if="mySide" class="tag" :class="mySide === 'BLUE' ? 'tag--blue' : 'tag--red'">{{ mySide === 'BLUE' ? 'You are blue' : 'You are red' }}</span>
      <span v-else />
    </header>

    <div class="room__body">
      <p v-if="error && phase !== 'DRAFT'" class="notice notice--bad" role="alert">{{ error }}</p>
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
        <p class="lobby__count num">{{ lobbyText }}</p>
        <button
          v-if="fixture && lobbyLeft > 20"
          class="btn" :class="{ 'btn--ghost': iAmReady }" type="button"
          :disabled="readyBusy" @click="toggleReady"
        >{{ iAmReady ? 'Ready: waiting for them' : 'Ready, start when they are' }}</button>
        <p class="lobby__note faint">
          <template v-if="state?.isBot && state?.source === 'BOT' && state?.difficulty">Practice against the agent on {{ DIFFICULTY_LABEL[asDifficulty(state.difficulty)] }}. It does not count anywhere.</template>
          <template v-else-if="state?.isBot">Nobody was searching, so the agent takes the other side.</template>
          <template v-else>{{ opponentHere ? 'They are here.' : 'Waiting for them to load…' }}</template>
          <template v-if="lobbyLeft > 60">Bans open at kick-off, or as soon as you are both ready.</template>
          <template v-else>Bans open in a moment; nobody's clock is running yet.</template>
        </p>
      </section>

      <!-- ===== The shared watch, and then the result ============================ -->
      <template v-else-if="(phase === 'WATCH' || phase === 'RESULT') && state?.result">
        <p v-if="phase === 'WATCH' && !spectating" class="notice notice--live">
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

        <div v-if="phase === 'RESULT' && spectating" class="again">
          <NuxtLink class="btn btn--lg" to="/leagues">Back to the league</NuxtLink>
        </div>
        <div v-else-if="phase === 'RESULT'" class="again">
          <button
            v-if="rematchLabel" class="btn btn--lg" type="button"
            :disabled="rematchBusy" @click="rematch"
          >{{ rematchBusy ? 'Starting' : rematchLabel }}</button>
          <NuxtLink v-if="state.source === 'LEAGUE'" class="btn btn--ghost btn--lg" to="/leagues">League table</NuxtLink>
          <NuxtLink class="btn btn--lg" :class="{ 'btn--ghost': rematchLabel }" to="/duels">Battle again</NuxtLink>
          <p v-if="rematchNote" class="again__note" role="status">{{ rematchNote }}</p>
        </div>
      </template>

      <!-- The draft finished but the result has not arrived on this client yet. -->
      <section v-else-if="phase === 'WATCH' || phase === 'RESULT'" class="lobby">
        <p class="lobby__state"><i aria-hidden="true" />Drafted</p>
        <p class="lobby__note">Both fives are in. Loading the match…</p>
      </section>

      <!-- ===== The draft ======================================================= -->
      <template v-else-if="state && phase === 'DRAFT'">
        <!-- Sticky on a phone, so whose turn it is and the clock stay in sight over the grid. -->
        <div class="dhead">
          <section class="turn" :class="{ 'is-mine': state.myTurn }">
            <div class="turn__main">
              <p class="turn__who" aria-live="polite">
                <template v-if="state.myTurn">Your {{ isPick ? 'pick' : 'ban' }}</template>
                <template v-else-if="theirHover">{{ state.opponent }} eyes {{ theirHover.championName }}</template>
                <template v-else>{{ state.opponent }} is {{ isPick ? 'picking' : 'banning' }}</template>
              </p>
              <p class="turn__phase">
                <template v-if="inBonus">{{ bonusLine }}</template>
                <template v-else>
                  <span>{{ state.step ? PHASE_LABEL[state.step.phase] : 'Draft' }} · step {{ Math.min((state.turn ?? 0) + 1, 20) }} of 20</span>
                  <span
                    class="bonuschip tnum"
                    title="Bonus time: once a turn's 30 seconds run out, this pool is spent before the agent steps in. It lasts the whole draft."
                  >+{{ myBonus }}s<span class="bonuschip__word"> bonus</span></span>
                </template>
              </p>
            </div>
            <div class="timer" :class="{ 'is-low': lowTime, 'is-bonus': inBonus }">
              <span v-if="inBonus" class="timer__label">Bonus</span>
              <b class="num" :aria-label="`${secondsLeft ?? 0} seconds left${inBonus ? ' of bonus time' : ''}`">{{ secondsLeft ?? '—' }}</b>
              <span class="timer__bar"><i :style="{ width: `${timerShare}%` }" /></span>
            </div>
          </section>

          <p v-if="error" class="notice notice--bad dhead__err" role="alert">{{ error }}</p>

          <div class="seq" role="img" :aria-label="seqLabel">
            <i v-for="s in seq" :key="s.i" :class="[s.side, s.state, { ban: s.ban }]" />
          </div>

          <!-- On a phone: blue bans, what is next, red bans, on one line that stays in sight. -->
          <div class="dhead__strip">
            <p class="order" aria-hidden="true">
              <span class="order__next">{{ nextLine }}</span>
              <span class="order__mine" :class="{ 'is-now': order.stepsUntilMine === 0 }">{{ mineLine }}</span>
            </p>
            <div class="dhead__bans">
              <span
                v-for="side in ['BLUE', 'RED']" :key="side"
                class="dhead__banrow" :class="`is-${side.toLowerCase()}`"
                role="group" :aria-label="`${nameOf(side)} bans`"
              >
                <span v-for="n in 5" :key="n" class="ban ban--s" :class="{ 'is-empty': !sideActions(side, 'BAN')[n - 1] }">
                  <img
                    v-if="sideActions(side, 'BAN')[n - 1]"
                    :src="art(sideActions(side, 'BAN')[n - 1].championKey)"
                    :alt="`${sideActions(side, 'BAN')[n - 1].championName} banned`"
                  >
                </span>
              </span>
            </div>
          </div>
        </div>

        <!-- the board, laid out like the broadcast: blue left, red right -->
        <section class="board">
          <div v-for="side in ['BLUE', 'RED']" :key="side" class="col" :class="`col--${side.toLowerCase()}`">
            <div class="col__head">
              <b :title="nameOf(side)">{{ nameOf(side) }}</b>
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
                  'is-empty': !pickFor(side, slot) && !hoverOn(side, slot),
                  'is-hover': hoverOn(side, slot),
                  'is-auto': pickFor(side, slot)?.auto,
                }"
              >
                <img v-if="pickFor(side, slot)" :src="splash(pickFor(side, slot).championKey)" alt="" class="pick__art" loading="lazy">
                <img
                  v-else-if="hoverOn(side, slot) && theirHover?.championKey"
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

            <!-- The composition as the engine reads it. Theirs without the number. -->
            <div v-if="compOf(side)" class="comp" :aria-label="side === mySide ? 'Your composition' : 'Their composition'">
              <p class="comp__head">
                <span>{{ side === mySide ? 'Your comp' : 'Their comp' }}</span>
                <b v-if="side === mySide && compOf(side).modifier !== null" class="tnum">×{{ compOf(side).modifier.toFixed(2) }}</b>
              </p>
              <ul class="comp__list">
                <li :class="{ 'is-ok': compOf(side).frontline === 2 }">Frontline <b class="tnum">{{ compOf(side).frontline }}/2</b></li>
                <li :class="{ 'is-ok': compOf(side).engage }">Engage <b>{{ compOf(side).engage ? 'yes' : '—' }}</b></li>
                <li :class="{ 'is-ok': compOf(side).peel }">Peel <b>{{ compOf(side).peel ? 'yes' : '—' }}</b></li>
                <li :class="{ 'is-ok': compOf(side).aoe >= 2 }">AoE <b class="tnum">{{ compOf(side).aoe }}</b></li>
                <li :class="{ 'is-ok': compOf(side).ad > 0 && compOf(side).ap > 0 }">Damage <b class="tnum">{{ compOf(side).ad }} AD · {{ compOf(side).ap }} AP</b></li>
              </ul>
              <p v-if="side === mySide && compOf(side).factors" class="comp__factors">
                <template v-for="(f, n) in compOf(side).factors" :key="f.name">{{ n ? ' · ' : '' }}{{ f.name }} <span :class="f.value >= 0 ? 'is-up' : 'is-down'">{{ f.value >= 0 ? '+' : '' }}{{ Math.round(f.value * 100) }}%</span></template>
              </p>
              <p v-else-if="side === mySide" class="comp__hint faint">Scored once all five are in: two frontline, engage, peel, AoE and mixed damage.</p>
            </div>
          </div>
        </section>

        <!-- choose a slot before picking -->
        <section v-if="state.myTurn && isPick" class="slotpick">
          <p class="slotpick__label">Into</p>
          <div class="slots" role="group" aria-label="Lineup slot">
            <button
              v-for="slot in openSlots" :key="slot" type="button" class="slot"
              :aria-pressed="(chosenSlot || targetSlot) === slot"
              :class="{ 'is-auto': !chosenSlot && targetSlot === slot }"
              @click="chosenSlot = chosenSlot === slot ? null : slot"
            >
              <b>{{ slot }}</b>
              <span class="slot__who">{{ myLineup[slot]?.name || '—' }}</span>
              <span v-if="selected" class="slot__m tnum" :class="{ 'is-zero': !masteryOn(myLineup, slot, selected.key) }">
                {{ masteryOn(myLineup, slot, selected.key) || 'no' }}<template v-if="!masteryOn(myLineup, slot, selected.key)"> pool</template>
              </span>
            </button>
          </div>
          <p class="faint slotpick__note">
            <template v-if="selected && !chosenSlot && targetSlot">Goes to {{ targetSlot }} unless you choose. Numbers are mastery on {{ selected.name }}.</template>
            <template v-else-if="selected && !targetSlot">Nobody in your five plays {{ selected.name }}. Choose where it goes.</template>
            <template v-else>Unchosen, a pick goes to the open slot with the most mastery on it.</template>
          </p>
        </section>

        <!-- The agent's advice, in your seat. -->
        <section v-if="state.myTurn && (pickTips.length || banTips.length)" class="advice">
          <p class="advice__head">
            <template v-if="isPick">Best for your {{ adviceSlot }}</template>
            <template v-else>Hurts them most</template>
          </p>
          <ul class="advice__list">
            <li v-for="t in (isPick ? pickTips : banTips)" :key="t.championKey">
              <button
                type="button" class="tip" :class="{ 'is-sel': selected?.key === t.championKey }"
                @click="consider({ key: t.championKey, name: t.championName }, isPick && adviceSlot ? adviceSlot : undefined)"
              >
                <img :src="art(t.championKey)" alt="">
                <span class="tip__text">
                  <b>{{ t.championName }}</b>
                  <span v-if="isPick" class="tnum">mastery {{ t.mastery }} · rating {{ t.rating }}</span>
                  <span v-else class="tnum">denies {{ t.victim?.name }} −{{ t.cost }}</span>
                </span>
              </button>
            </li>
          </ul>
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
                  v-if="!c.gone && (showsTheirs ? c.theirs : c.mine) > 0"
                  class="champ__m tnum"
                  :class="{ 'is-theirs': showsTheirs }"
                >
                  {{ showsTheirs ? c.theirs : c.mine }}
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
            <template v-if="selected && isPick && targetSlot">
              <b>{{ selected.name }} to {{ targetCard?.name || targetSlot }}</b>
              <span>into {{ targetSlot }} · mastery {{ targetMastery }}<template v-if="!targetMastery"> (not in their pool)</template></span>
            </template>
            <template v-else-if="selected && isPick">
              <b>{{ selected.name }}</b>
              <span>Choose a slot: nobody in your five plays it</span>
            </template>
            <template v-else-if="selected">
              <b>Ban {{ selected.name }}</b>
              <span>Gone for both sides</span>
            </template>
            <template v-else>
              <b>Choose a champion</b>
              <span>Tap one, then lock it in</span>
            </template>
          </p>
          <button
            class="btn lockbar__go" type="button" data-sound="none"
            :disabled="!selected || busy || (isPick && !targetSlot)" @click="lockIn"
          >
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
.room__bar .icon-btn { width: 44px; height: 44px; }
.room__vs { margin: 0; font-size: 14px; color: var(--ink-2); text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.room__vs b { color: var(--ink-1); font-weight: 680; }

/* Is the other person in the room. A dot, plus words for a screen reader and for "away". */
.presence { display: inline-block; width: 7px; height: 7px; margin-left: 6px; vertical-align: 1px; border-radius: 50%; background: var(--ink-4); }
.presence.is-here { background: var(--teal-2); }

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
.again__note { flex-basis: 100%; margin: 0; text-align: center; font-size: 13.5px; color: var(--ink-2); }
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
/* The header that stays: turn, clock, order, bonus, bans. Sticky under the bar on a phone. */
.dhead {
  position: sticky;
  top: calc(52px + env(safe-area-inset-top, 0px));
  z-index: 15;
  background: var(--bg-2);
  border-bottom: 1px solid var(--line-1);
}
.dhead__err { margin: 0 16px 8px; }

.turn { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 10px 16px 8px; }
.turn.is-mine { background: linear-gradient(90deg, rgba(31, 207, 193, 0.14), rgba(31, 207, 193, 0.02) 70%); }
.turn__main { min-width: 0; }
.turn__who { margin: 0; font-stretch: 80%; font-weight: 840; font-size: 20px; line-height: 1.05; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.turn.is-mine .turn__who { color: var(--teal-1); }
.turn__phase { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; margin: 3px 0 0; font-size: 12px; color: var(--ink-3); }
.timer { display: grid; justify-items: end; gap: 5px; min-width: 64px; }
.timer b { font-size: 34px; line-height: 0.85; }
.timer__label { font-stretch: 112%; font-size: 10px; font-weight: 760; letter-spacing: 0.12em; text-transform: uppercase; color: var(--gold-1); }
.timer__bar { display: block; width: 64px; height: 3px; background: var(--bg-4); }
.timer__bar i { display: block; height: 100%; background: var(--teal-2); transition: width 0.2s linear; }
.timer.is-bonus b { color: var(--gold-1); }
.timer.is-bonus .timer__bar i { background: var(--gold-2); }
.timer.is-low b { color: var(--warn-2); }
.timer.is-low .timer__bar i { background: var(--warn-2); }

.seq { display: grid; grid-template-columns: repeat(20, 1fr); gap: 2px; padding: 4px 16px 6px; }
.seq i { height: 4px; background: var(--bg-4); }
.seq i.done.b { background: rgba(74, 144, 255, 0.6); }
.seq i.done.r { background: rgba(240, 80, 95, 0.6); }
.seq i.ban { opacity: 0.6; }
.seq i.now { background: var(--teal-2); opacity: 1; height: 6px; margin-top: -1px; }

.order { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin: 0; padding: 0 16px 8px; font-size: 12px; color: var(--ink-3); }
.order__mine { color: var(--ink-2); }
.order__mine.is-now { color: var(--teal-1); font-weight: 650; }
.bonuschip { padding: 0 5px; border-radius: 2px; background: var(--bg-3); color: var(--gold-1); font-weight: 700; cursor: help; }

.dhead__bans { display: none; }
.dhead__banrow { display: flex; gap: 3px; }
.dhead__banrow.is-red { flex-direction: row-reverse; }
.ban--s { width: 18px !important; height: 18px !important; }

/* Each column's own track is minmax(0, 1fr) too: a long name must shorten, never widen its side. */
.board { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; padding: 12px 10px 0; }
.col { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; align-content: start; min-width: 0; }
.col__head { display: flex; justify-content: space-between; align-items: center; gap: 6px; margin-bottom: 4px; }
.col__head b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 720; }
.col--blue .col__head b { color: var(--blue-2); }
.col--red .col__head { flex-direction: row-reverse; }
.col--red .col__head b { color: var(--red-2); }
.bans { display: flex; flex: none; gap: 3px; }
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

/* The comp panel: what the engine will read off these five champions. */
.comp { margin-top: 6px; padding: 8px 9px; border: 1px solid var(--line-1); border-radius: 2px; background: var(--bg-1); }
.comp__head { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; margin: 0 0 4px; font-size: 11.5px; font-weight: 700; color: var(--ink-2); }
.comp__head b { color: var(--gold-1); font-size: 13px; }
.comp__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; font-size: 11.5px; color: var(--ink-3); }
.comp__list li { display: flex; justify-content: space-between; gap: 6px; }
.comp__list b { font-weight: 650; color: var(--ink-2); white-space: nowrap; }
.comp__list li.is-ok b { color: var(--teal-1); }
.comp__factors { margin: 6px 0 0; font-size: 11px; color: var(--ink-3); line-height: 1.4; }
.comp__factors .is-up { color: var(--teal-1); }
.comp__factors .is-down { color: var(--warn-2); }
.comp__hint { margin: 6px 0 0; font-size: 11px; line-height: 1.35; }

.slotpick { display: grid; gap: 8px; padding: 14px 16px 0; }
.slotpick__label { margin: 0; font-size: 13px; color: var(--ink-3); }
.slotpick__note { margin: 0; font-size: 12px; }
.slots { display: grid; grid-template-columns: repeat(auto-fit, minmax(0, 1fr)); gap: 4px; }
.slot {
  display: grid;
  justify-items: center;
  align-content: center;
  gap: 1px;
  min-height: 56px;
  min-width: 0;
  padding: 6px 4px;
  border: 1px solid var(--line-2);
  border-radius: 2px;
  background: var(--bg-2);
  color: var(--ink-2);
  font: inherit;
  cursor: pointer;
}
.slot b { font-stretch: 112%; font-size: 11px; letter-spacing: 0.08em; color: var(--ink-1); }
.slot__who { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; }
.slot__m { font-size: 11.5px; font-weight: 760; color: var(--gold-1); }
.slot__m.is-zero { color: var(--ink-4); font-weight: 600; }
.slot[aria-pressed='true'] { border-color: var(--teal-2); box-shadow: inset 0 0 0 1px var(--teal-2); }
.slot.is-auto[aria-pressed='true'] { border-style: dashed; box-shadow: none; }

/* The agent's advice. Three tiles, tapped like the grid. */
.advice { padding: 14px 16px 0; }
.advice__head { margin: 0 0 8px; font-size: 13px; font-weight: 650; color: var(--ink-2); }
.advice__list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.tip { display: grid; grid-template-columns: 40px minmax(0, 1fr); align-items: center; gap: 8px; width: 100%; min-height: 52px; padding: 6px; border: 1px solid var(--line-2); border-radius: 2px; background: var(--bg-2); color: inherit; font: inherit; text-align: left; cursor: pointer; }
.tip img { width: 40px; height: 40px; border-radius: 2px; }
.tip__text { min-width: 0; }
.tip__text b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.tip__text span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--ink-3); }
.tip.is-sel { border-color: var(--teal-2); }
@media (max-width: 520px) {
  .advice__list { grid-template-columns: 1fr; }
}

.pool { padding: 16px 16px 0; }
.pool__head { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 12px; margin-bottom: 12px; }
.pool__count { margin: 0; font-size: 13.5px; font-weight: 650; }
.pool__search { min-height: 44px; font-size: 16px; }
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
.lockbar__go { min-height: 44px; }

/* --- phone and tablet: the sticky header stays small, the grid gets the screen ---- */
@media (max-width: 1023px) {
  .timer.is-bonus { grid-template-columns: auto auto; align-items: end; column-gap: 6px; }
  .timer.is-bonus .timer__bar { grid-column: 1 / -1; }
  .dhead__strip { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 0 16px 8px; }
  .dhead__strip .order { grid-area: 1 / 2; justify-content: center; flex-wrap: nowrap; padding: 0; white-space: nowrap; }
  .order__next { display: none; }
  .order__mine { overflow: hidden; text-overflow: ellipsis; }
  .dhead__bans { display: contents; }
  .dhead__banrow.is-blue { grid-area: 1 / 1; }
  .dhead__banrow.is-red { grid-area: 1 / 3; }
  .col__head .bans { display: none; }
}
@media (max-width: 359px) {
  .dhead__banrow { gap: 2px; }
  .ban--s { width: 16px !important; height: 16px !important; }
  .bonuschip__word { display: none; }
}

/* --- desktop: two sides facing a central stage ---------------------------------- */
@media (min-width: 1024px) {
  .room__body { padding: 0 32px 32px; }
  .dhead { position: static; margin-top: 16px; border: 0; border-radius: var(--radius); background: var(--bg-2); }
  .turn { padding: 16px 24px 10px; border-radius: var(--radius) var(--radius) 0 0; }
  .turn__who { font-size: 32px; }
  .turn__phase { font-size: 12.5px; }
  .timer b { font-size: 60px; }
  .timer__bar { width: 96px; }
  .seq { padding: 6px 24px 8px; }
  .order { padding: 0 24px 12px; font-size: 12.5px; }
  .dhead__err { margin-left: 24px; margin-right: 24px; }
  .room--draft .room__body {
    display: grid;
    grid-template-columns: 300px minmax(0, 1fr) 300px;
    grid-template-areas: 'head head head' 'blue slot red' 'blue advice red' 'blue pool red';
    grid-template-rows: auto auto auto 1fr;
    column-gap: 24px;
    align-items: start;
  }
  .dhead { grid-area: head; }
  .board { display: contents; }
  .col { padding-top: 16px; }
  .col--blue { grid-area: blue; }
  .col--red { grid-area: red; }
  .pick { height: 92px; padding: 10px 14px; }
  .pick__text b { font-size: 16px; }
  .pick__text span { font-size: 12.5px; }
  .ban { width: 30px; height: 30px; }
  .col__head b { font-size: 15px; }
  .comp { padding: 10px 12px; }
  .comp__list { font-size: 12.5px; }
  .slotpick { grid-area: slot; padding: 16px 0 0; }
  .advice { grid-area: advice; padding: 14px 0 0; }
  .pool { grid-area: pool; margin-top: 16px; padding: 16px; background: var(--bg-1); border: 1px solid var(--line-1); border-radius: var(--radius); }
  .pool__grid { grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); max-height: 60vh; overflow: auto; }
  .lockbar { left: 50%; right: auto; bottom: 20px; width: min(640px, calc(100vw - 680px)); transform: translateX(-50%); border: 1px solid var(--line-2); border-radius: var(--radius); padding: 10px 14px; }
}

@media (prefers-reduced-motion: reduce) { .timer__bar i { transition: none; } }
</style>
