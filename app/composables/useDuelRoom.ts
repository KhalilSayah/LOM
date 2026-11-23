import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  phaseOf, watchClock, matchEnd, draftClock, RESULT_GRACE_SECONDS, WATCH_SPEED,
  type RoomPhase, type RoomTiming,
} from '~~/shared/duelRoom';

/**
 * A duel room, live, on both screens at once.
 *
 * This replaces the 700 ms poll the draft screen used to run, and the difference is not
 * really speed — it is that there is now one clock. Polling gives each client its own
 * sampling of a shared state, so two phones on different connections are looking at
 * different drafts up to a second apart, and the only way to make that not matter is to
 * make nothing in the experience depend on the exact moment. A shared draft, a shared
 * countdown and a shared watch all depend on exactly that.
 *
 * What is here:
 *
 *   - **State by push.** Postgres changes on the duel row and on its action log. Every write
 *     the server makes — a lock, a turn advancing, the draft ending into the watch — arrives
 *     at both clients from the same WAL event, which is as close to simultaneous as two
 *     devices get.
 *   - **Hover by broadcast.** Client to client, never through the database. What the
 *     opponent sees is this; the player's own selection is *also* saved to the server
 *     (saveSelection), but only so the clock can honour it, never to show anybody.
 *   - **Presence.** Who is actually in the room, which is what lets the screen say "they are
 *     here" rather than guessing from whether actions are arriving.
 *   - **One clock.** `offset` is measured against the server and every countdown and the
 *     whole shared watch are computed from it. A device with a wrong clock renders the same
 *     numbers as one without.
 *   - **A timer, not a poll.** `nudge` fires once, at the exact instant something is due.
 *     See /api/duel/[id]/nudge for why that is the piece polling was actually buying.
 *
 * Realtime is an accelerator over something pollable, never the source of truth
 * (docs/05 section 5.2): anything surprising triggers a resync against the state endpoint,
 * and if the channel cannot be established at all the room falls back to polling it.
 */

export interface RoomState {
  id: string;
  status: string;
  source: string;
  side: 'BLUE' | 'RED' | null;
  opponent: string;
  opponentId: string | null;
  isBot: boolean;
  botSide: string | null;
  difficulty: string | null;
  turn: number;
  length: number;
  order: any[];
  step: any | null;
  myTurn: boolean;
  startsAt: string | null;
  deadlineAt: string | null;
  botActsAt: number | null;
  watchStartAt: string | null;
  watchSpeed: number;
  serverNow: string;
  updatedAt: string | null;
  bonus: Record<string, any>;
  myHover: { championKey: string; championName: string; slot: string | null } | null;
  actions: any[];
  blueLineup: any;
  redLineup: any;
  composition: { mine: any; theirs: any } | null;
  pool?: Array<{ key: string; name: string; roles?: string[] }>;
  result: any | null;
  rewards?: any;
}

export interface Hover {
  side: string;
  kind: string;
  turn: number;
  championKey: string | null;
  championName: string | null;
  slot: string | null;
}

/** How long the channel may be down on first load before the screen says so. */
const RECONNECT_GRACE_MS = 4000;

export function useDuelRoom(duelId: string) {
  const supabase = useSupabaseClient();
  const me = useManagerId();

  const state = ref<RoomState | null>(null);
  const pool = ref<Array<{ key: string; name: string; roles?: string[] }>>([]);
  const error = ref('');
  const loading = ref(true);
  /** Their hover, as broadcast. Ours is local and never round-trips. */
  const theirHover = ref<Hover | null>(null);
  const opponentHere = ref(false);
  /** False while the channel is down and the room is on its polling fallback. */
  const live = ref(false);
  /** True once the channel has been up at least once, so a first connect is not a "reconnect". */
  const everLive = ref(false);
  const mountedAt = ref(0);

  /**
   * Server time minus ours.
   *
   * Corrected for the round trip: `serverNow` was true about half a round trip before it
   * arrived, so taking it at face value leaves each device out by its own latency — which is
   * exactly how two phones on different connections came to show different numbers for the
   * same deadline. Charging half the measured round trip puts them within tens of
   * milliseconds. Both the resync and the nudge correct this way; the nudge used not to,
   * and every nudge undid the correction the last resync had made.
   */
  let offset = 0;
  const now = ref(Date.now());
  /** The corrected clock. Everything that compares against a server instant uses this. */
  const clock = computed(() => now.value + offset);

  const sample = (serverNow: string, sentAt: number) => {
    const arrived = Date.now();
    offset = new Date(serverNow).getTime() + (arrived - sentAt) / 2 - arrived;
  };

  let channel: RealtimeChannel | null = null;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let fallback: ReturnType<typeof setInterval> | undefined;
  let dueTimer: ReturnType<typeof setTimeout> | undefined;
  let resyncTimer: ReturnType<typeof setTimeout> | undefined;
  let selectionTimer: ReturnType<typeof setTimeout> | undefined;
  let nudging = false;

  // --- the authoritative read ------------------------------------------------

  async function resync(withPool = false) {
    try {
      const sentAt = Date.now();
      const next = await $fetch<RoomState>(
        `/api/duel/${duelId}${withPool ? '?pool=1' : ''}`,
      );
      sample(next.serverNow, sentAt);
      if (next.pool) pool.value = next.pool;
      state.value = next;
      error.value = '';
      scheduleDue();
    } catch (e: any) {
      // The last good state stays on screen. A dropped request on a phone is ordinary and
      // blanking a live draft for it is worse than being a moment stale.
      error.value = e?.data?.statusMessage || e?.message || 'Could not reach the room.';
    } finally {
      loading.value = false;
    }
  }

  /**
   * Coalesced resync.
   *
   * A single server write can produce two pushes — the action row and the duel row — and a
   * burst at the end of the draft produces several. Debouncing means a flurry costs one read
   * rather than one each, and 60 ms is short enough that nobody perceives it.
   */
  function resyncSoon() {
    clearTimeout(resyncTimer);
    resyncTimer = setTimeout(() => resync(), 60);
  }

  // --- the one timer ---------------------------------------------------------

  /** The next instant at which the server would change something if asked. */
  function dueAt(): number | null {
    const s = state.value;
    if (!s) return null;
    if (s.status === 'DRAFTING') {
      // Whichever comes first: the agent moving, or the action timer expiring.
      const ends = s.deadlineAt ? new Date(s.deadlineAt).getTime() : null;
      const bot = s.botActsAt ?? null;
      if (ends === null) return bot;
      return bot === null ? ends : Math.min(ends, bot);
    }
    if (s.status === 'WATCHING' && s.watchStartAt && s.result) {
      /**
       * When the room can be *settled*, not when the match ends.
       *
       * These are twenty seconds apart on purpose (RESULT_GRACE_SECONDS) and using the
       * wrong one here is a hot loop rather than a cosmetic mistake: a nudge at the end of
       * the match finds watchSettled() still false, changes nothing, reschedules against an
       * instant that is now in the past, and fires again immediately. The move from WATCH to
       * RESULT needs no nudge at all — it is a clock comparison both clients make locally.
       *
       * The match ends at matchEnd(result), the last event, which is what the server settles
       * against as well.
       */
      const wall = matchEnd(s.result) / (s.watchSpeed || WATCH_SPEED);
      return new Date(s.watchStartAt).getTime() + (wall + RESULT_GRACE_SECONDS) * 1000;
    }
    return null;
  }

  /**
   * How many nudges in a row have come back with nothing to show for themselves.
   *
   * There is always a reading of the state where the next thing is already due and asking
   * does not change it — a side's bonus pool being staked extends the deadline without
   * moving the turn, a clock offset can be a shade pessimistic, a write can be in flight.
   * Without a back-off each of those is a request every tenth of a second for as long as it
   * lasts, which is worse than the polling this replaced and harder to notice.
   */
  let misses = 0;

  function scheduleDue() {
    clearTimeout(dueTimer);
    const due = dueAt();
    if (due === null) {
      misses = 0;
      return;
    }
    // In the corrected clock's terms, then back into this device's.
    const waitMs = due - clock.value + 250;
    if (waitMs > 0) {
      misses = 0;
      dueTimer = setTimeout(nudge, waitMs);
    } else {
      // Due already, and asking did not help. Ask again, less often each time.
      const backoff = Math.min(8000, 400 * 2 ** misses);
      misses += 1;
      dueTimer = setTimeout(nudge, backoff);
    }
  }

  /**
   * Ask the server to bring the room up to date, once, because something is due.
   *
   * Both clients will usually do this within a few hundred milliseconds of each other and
   * that is fine: whatever the clock implies has happened happens once, and the second
   * request finds it already done. The guard is only against this client stacking its own.
   */
  async function nudge() {
    if (nudging) return;
    nudging = true;
    try {
      const sentAt = Date.now();
      const res = await $fetch<any>(`/api/duel/${duelId}/nudge`, { method: 'POST' });
      // A nudge is also a clock sample and a cheap state check, so take both.
      if (res?.serverNow) sample(res.serverNow, sentAt);

      if (!state.value || res.status !== state.value.status || res.turn !== state.value.turn) {
        await resync();
        return;
      }

      /**
       * Nothing moved, but the clock may still have — a side whose action timer ran out has
       * its bonus pool staked behind that one action and the deadline pushed out by exactly
       * that much, which changes when the next thing is due without changing whose turn it
       * is. Taking the new instants from the response is what stops the next schedule being
       * computed against a deadline that has already passed.
       */
      state.value.deadlineAt = res.deadlineAt ?? state.value.deadlineAt;
      state.value.botActsAt = res.botActsAt ?? null;
      if (res.bonus) state.value.bonus = res.bonus;
      scheduleDue();
    } catch {
      scheduleDue();
    } finally {
      nudging = false;
    }
  }

  // --- the channel -----------------------------------------------------------

  function subscribe() {
    channel = supabase
      .channel(`duel:${duelId}`, { config: { presence: { key: me.value || 'anon' } } })

      /**
       * The duel row: the turn, the clock, the phase. Every server write that changes what a
       * screen draws bumps `updated_at`, so this fires even when the visible change is only a
       * cursor moving.
       *
       * The one write that does not bump it is a player's selection being saved for the
       * clock (hover.post.ts). Its push carries the same `updated_at` the screen already
       * has, and is skipped — otherwise every tap on a champion would cost both players a
       * full resync.
       */
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'duels', filter: `id=eq.${duelId}` },
        (payload: any) => {
          const stamp = payload?.new?.updated_at;
          const known = state.value?.updatedAt;
          if (stamp && known && new Date(stamp).getTime() === new Date(known).getTime()) return;
          resyncSoon();
        },
      )

      /**
       * The action log: a ban or a pick becoming final.
       *
       * Subscribed separately from the duel row rather than inferred from it, because the
       * insert is the lock — it is the row whose unique indexes decide that a champion is
       * gone — and it is the event the screen animates.
       */
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'duel_actions', filter: `duel_id=eq.${duelId}` },
        () => resyncSoon(),
      )

      /**
       * Hover, client to client. Never trusted, never acted on: it is a thing to look at while
       * somebody decides. The action log still decides what happened.
       *
       * A hover with no champion is a clear, and a hover for a step other than the current
       * one is stale. Both used to be ignored, which is how "X eyes Ahri" stayed on screen
       * after X had locked something else, or moved on to the next step.
       */
      .on('broadcast', { event: 'hover' }, ({ payload }) => {
        const h = payload as Hover | null;
        if (!state.value) return;
        if (h && h.side === state.value.side) return;
        if (!h || !h.championKey || h.turn !== state.value.turn) {
          theirHover.value = null;
          return;
        }
        theirHover.value = h;
      })

      .on('presence', { event: 'sync' }, () => {
        const here = channel?.presenceState() || {};
        opponentHere.value = Object.keys(here).some((k) => k !== me.value);
      })

      .subscribe((status) => {
        live.value = status === 'SUBSCRIBED';
        if (status === 'SUBSCRIBED') {
          everLive.value = true;
          stopFallback();
          channel?.track({ at: new Date().toISOString() });
          // Whatever was missed between the last read and the subscription being live.
          resync();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          startFallback();
        }
      });
  }

  /**
   * The fallback, and the reason it is only a fallback.
   *
   * Two seconds, per docs/05 section 5.2: "the draft becomes less snappy and remains
   * completely playable". It is not 700 ms — if realtime is gone the room has already lost
   * the thing that made it shared, and hammering the endpoint will not bring it back.
   */
  function startFallback() {
    if (fallback) return;
    fallback = setInterval(() => resync(), 2000);
  }
  function stopFallback() {
    clearInterval(fallback);
    fallback = undefined;
  }

  /**
   * Tell the other side what we are considering. Fire and forget, by design. `null` clears
   * it, which is sent as an explicit empty hover so the receiver can tell it apart from a
   * message it failed to read.
   */
  function sendHover(h: Hover | null) {
    const s = state.value;
    const payload: Hover = h ?? {
      side: s?.side ?? '',
      kind: s?.step?.kind ?? '',
      turn: s?.turn ?? -1,
      championKey: null,
      championName: null,
      slot: null,
    };
    channel?.send({ type: 'broadcast', event: 'hover', payload });
  }

  /**
   * Save what is in my hand, so that if the clock beats me it locks this rather than
   * something the agent picks. Debounced: a player flicking through three champions should
   * cost one write, not three. Best effort — a failure leaves the old behaviour.
   */
  function saveSelection(sel: { turn: number; championKey: string | null; slot: string | null }) {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      $fetch(`/api/duel/${duelId}/hover`, { method: 'POST', body: sel }).catch(() => {});
    }, 250);
  }

  // --- derived --------------------------------------------------------------

  const timing = computed<RoomTiming>(() => ({
    status: state.value?.status ?? 'PENDING',
    startsAt: state.value?.startsAt ?? null,
    watchStartAt: state.value?.watchStartAt ?? null,
    watchSpeed: state.value?.watchSpeed ?? 60,
    // The last event, not gameLength: the nexus can fall up to a minute of match time later.
    gameLength: state.value?.result ? matchEnd(state.value.result) : null,
  }));

  const phase = computed<RoomPhase>(() => phaseOf(timing.value, clock.value));

  /** Where the shared match is, in match seconds. The same number on both screens. */
  const matchClock = computed(() => watchClock(timing.value, clock.value));

  /**
   * The clock for the side on the move: its thirty seconds, then its bonus pool, as one
   * countdown that never jumps (shared/duelRoom.ts draftClock).
   */
  const turnClock = computed(() => {
    if (phase.value !== 'DRAFT' || !state.value?.step) return null;
    return draftClock({
      deadlineAt: state.value.deadlineAt,
      bonus: state.value.bonus,
      side: state.value.step.side,
      botSide: state.value.botSide,
      now: clock.value,
    });
  });

  const secondsLeft = computed(() => turnClock.value?.shown ?? null);

  /** Seconds until the draft opens, while the lobby is up. */
  const lobbyLeft = computed(() => {
    if (phase.value !== 'LOBBY' || !state.value?.startsAt) return 0;
    return Math.max(0, (new Date(state.value.startsAt).getTime() - clock.value) / 1000);
  });

  /**
   * Whether to tell the player the room is reconnecting.
   *
   * Not on the first load: the channel takes a moment to come up on every page open, and
   * flashing "reconnecting" at somebody who has just arrived says something is wrong when
   * nothing is. Only once it has been up and dropped, or if it never comes up at all.
   */
  const reconnecting = computed(() => {
    if (live.value || !state.value) return false;
    if (everLive.value) return true;
    return mountedAt.value > 0 && now.value - mountedAt.value > RECONNECT_GRACE_MS;
  });

  // A hover belongs to one step; a new step drops whatever was being shown for the last one.
  watch(() => state.value?.turn, () => { theirHover.value = null; });

  // The phase boundaries are clock-driven, so the screen has to be told when one passes even
  // though nothing arrived. 100 ms keeps the shared watch smooth without a render per frame.
  watch(phase, () => scheduleDue());

  onMounted(async () => {
    mountedAt.value = Date.now();
    await resync(true);
    ticker = setInterval(() => { now.value = Date.now(); }, 100);
    subscribe();
    if (import.meta.client) {
      document.addEventListener('visibilitychange', onVisible);
    }
  });

  /**
   * Coming back to the tab is the one moment a client is guaranteed to be wrong.
   *
   * A backgrounded mobile browser throttles timers and may have dropped the socket without
   * saying so, so the draft on screen can be a minute old. Resync rather than trust it.
   */
  function onVisible() {
    if (document.visibilityState === 'visible') resync();
  }

  onBeforeUnmount(() => {
    clearInterval(ticker);
    clearTimeout(dueTimer);
    clearTimeout(resyncTimer);
    clearTimeout(selectionTimer);
    stopFallback();
    if (import.meta.client) document.removeEventListener('visibilitychange', onVisible);
    if (channel) supabase.removeChannel(channel);
  });

  return {
    state, pool, error, loading, live, reconnecting,
    phase, clock, matchClock, secondsLeft, turnClock, lobbyLeft,
    theirHover, opponentHere,
    sendHover, saveSelection, resync, nudge,
  };
}
