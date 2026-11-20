import type { RealtimeChannel } from '@supabase/supabase-js';

/**
 * Searching for a duel.
 *
 * The state machine is three words long — idle, searching, found — and almost all of the
 * care here is in the second one. A search has no server to poll usefully: nothing happens
 * until another person presses the button, and when they do, *their* request is what pairs
 * the two of us. So this does not ask repeatedly whether anything has happened. It subscribes
 * to its own queue row and waits to be told.
 *
 * Two timers run alongside, and both exist because of what an empty queue does to somebody:
 *
 *   - A heartbeat. A queue row is a claim on being here now, and there is no event for
 *     closing the app, so the row has to be refreshed or it is swept as a ghost. Refreshing
 *     also re-attempts pairing, which covers the case where both clients' subscriptions were
 *     momentarily down.
 *   - The bot offer. After about twenty seconds of nobody, the screen offers the agent. The
 *     search carries on underneath it: the offer is a button, not a timeout, and a human who
 *     turns up while it is on screen still wins.
 */

const BOT_OFFER_AFTER_MS = 20_000;
const HEARTBEAT_MS = 15_000;

export function useDuelQueue() {
  const supabase = useSupabaseClient();
  const me = useManagerId();

  const searching = ref(false);
  const waiting = ref(0);
  const error = ref('');
  const busy = ref(false);
  const elapsed = ref(0);

  let channel: RealtimeChannel | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let startedAt = 0;

  /** True once the queue has been empty long enough to be worth offering the agent. */
  const botOffered = computed(() => searching.value && elapsed.value * 1000 >= BOT_OFFER_AFTER_MS);

  /**
   * Go to the room, once.
   *
   * Guarded because three things call it — the realtime push, the heartbeat and restore() —
   * and they can agree. Without the guard a single pairing could fire several navigations,
   * and a navigation to the route we are already on is a loop with a screen flash in it.
   */
  const entered = ref<string | null>(null);

  function enter(duelId: string) {
    if (entered.value === duelId) return;
    entered.value = duelId;
    stop();
    searching.value = false;
    // Tidy up after ourselves so the row is not swept later as a mystery. It is not needed
    // any more: both clients know the duel id, and the room is where they live now.
    $fetch('/api/duel/queue/leave', { method: 'POST' }).catch(() => {});
    return navigateTo(`/duel/${duelId}`);
  }

  /**
   * Start the two timers that run alongside a search, having stopped any already running.
   *
   * search() and restore() both used to set these inline, and both can run in one visit to
   * the screen — restore() on mount, search() on the press. The second set orphaned the
   * first, so the heartbeat ran twice over and sent a join for every copy.
   */
  function beginSearch(since: number) {
    stop();
    searching.value = true;
    startedAt = since;
    elapsed.value = (Date.now() - startedAt) / 1000;
    subscribe();
    heartbeat = setInterval(refresh, HEARTBEAT_MS);
    ticker = setInterval(() => { elapsed.value = (Date.now() - startedAt) / 1000; }, 250);
  }

  async function search() {
    if (busy.value) return;
    busy.value = true;
    error.value = '';
    try {
      const res = await $fetch<any>('/api/duel/queue/join', { method: 'POST' });
      if (res.duelId) return enter(res.duelId);

      waiting.value = res.waiting ?? 0;
      beginSearch(Date.now());
    } catch (e: any) {
      error.value = e?.data?.statusMessage || e?.message || 'Could not start a search.';
    } finally {
      busy.value = false;
    }
  }

  /**
   * Refresh the claim, and re-attempt pairing while we are there.
   *
   * Calling join again is deliberately the same request as starting a search: the function
   * behind it does not move an existing row down the queue, so a heartbeat cannot cost
   * somebody their place.
   */
  async function refresh() {
    if (!searching.value) return;
    try {
      const res = await $fetch<any>('/api/duel/queue/join', { method: 'POST' });
      if (res.duelId) return enter(res.duelId);
      waiting.value = res.waiting ?? 0;
    } catch {
      // A failed heartbeat is not worth telling anyone about; the next one is 15 seconds away
      // and the row survives 90.
    }
  }

  function subscribe() {
    if (!me.value) return;
    channel = supabase
      .channel(`queue:${me.value}`)
      /**
       * Our own queue row being updated means exactly one thing: somebody paired with us.
       * duel_matchmake sets duel_id on both rows inside the pairing transaction, so this push
       * is the first moment either client could possibly know, and it is the same moment for
       * both of them.
       */
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'duel_queue',
          filter: `profile_id=eq.${me.value}`,
        },
        ({ new: row }: any) => {
          if (row?.duel_id) enter(row.duel_id);
        },
      )
      .subscribe((status) => {
        // If the channel will not come up, the heartbeat is the whole mechanism rather than a
        // safety net: it re-attempts pairing every 15 seconds, so a search still resolves.
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') refresh();
      });
  }

  /** Take the agent. The search is not cancelled first — the request itself ends it. */
  async function playBot() {
    if (busy.value) return;
    busy.value = true;
    try {
      const res = await $fetch<any>('/api/duel/queue/bot', { method: 'POST' });
      if (res.duelId) return enter(res.duelId);
    } catch (e: any) {
      error.value = e?.data?.statusMessage || e?.message || 'Could not start that match.';
    } finally {
      busy.value = false;
    }
  }

  async function cancel() {
    stop();
    searching.value = false;
    try {
      await $fetch('/api/duel/queue/leave', { method: 'POST' });
    } catch { /* The row is swept in 90 seconds regardless. */ }
  }

  function stop() {
    clearInterval(heartbeat);
    clearInterval(ticker);
    heartbeat = undefined;
    ticker = undefined;
    if (channel) {
      supabase.removeChannel(channel);
      channel = null;
    }
  }

  /** Pick up a search or a room left behind by a reload. */
  async function restore() {
    try {
      const res = await $fetch<any>('/api/duel/queue/status');
      if (res.duelId) return enter(res.duelId);
      waiting.value = res.waiting ?? 0;
      if (res.searching && res.since) beginSearch(new Date(res.since).getTime());
    } catch { /* Signed out, or offline. The button still works. */ }
  }

  onBeforeUnmount(stop);

  return { searching, waiting, elapsed, botOffered, error, busy, search, cancel, playBot, restore };
}
