import type { RealtimeChannel } from '@supabase/supabase-js';

/**
 * What the duel part of the game wants from you, shared across every screen.
 *
 * Two different things. A challenge is the one thing in the game that arrives without you
 * doing anything, so it needs telling. A *live room* is stronger than that: if you are
 * mid-draft and looking at your collection, the nav should not say "1 duel" — it should
 * offer to put you back, because somebody is sitting on the other side of that draft
 * watching your clock run down.
 *
 * Told by push, counted by poll. Three moments arrive as realtime events on rows this
 * manager can already read — a challenge sent to them, a challenge of theirs being
 * accepted, their queue row being paired — and each raises a toast with a sound wherever
 * they are in the app (DuelToast.vue). The badge counts are still re-read slowly, as the
 * safety net realtime always needs (docs/05 section 5.2), but only while the tab is visible
 * and somebody is signed in: a hidden tab polling every twenty seconds for a dot nobody can
 * see is a cost with no reader.
 */

export interface DuelToast {
  key: string;
  kind: 'challenge' | 'accepted' | 'paired';
  title: string;
  body: string;
  duelId: string | null;
  /** Where the button goes. */
  to: string;
  action: string;
}

const POLL_MS = 20_000;

export function useDuelSignal() {
  const incoming = useState('duel-incoming', () => 0);
  const drafting = useState('duel-drafting', () => 0);
  /**
   * The room to be put back into, if there is one.
   *
   * Null once a match has finished playing, even though the duel row stays WATCHING for
   * another twenty seconds — the server decides that by phase, not status, so the nav stops
   * offering to send somebody back into a game they have just watched to the end.
   */
  const liveDuelId = useState<string | null>('duel-live-id', () => null);
  const toast = useState<DuelToast | null>('duel-toast', () => null);
  const started = useState('duel-polling', () => false);

  // Taken here, in the caller's setup, because start() can run later from a watcher where
  // there is no component to inject from.
  const supabase = useSupabaseClient();
  const me = useManagerId();
  const route = useRoute();

  async function refresh() {
    try {
      const res = await $fetch<{
        incoming: number;
        drafting: number;
        liveDuelId: string | null;
        liveOpponent: string | null;
        latestIncoming: { id: string; from: string; at: string } | null;
      }>('/api/duel/pending');
      incoming.value = res.incoming;
      drafting.value = res.drafting;
      liveDuelId.value = res.liveDuelId;
      return res;
    } catch {
      // Signed out, offline, or the migration has not been run. A badge is not worth an error.
      return null;
    }
  }

  function dismiss() {
    toast.value = null;
  }

  /** Starts once per session, from the layout, and only in the browser. */
  function start() {
    if (started.value || import.meta.server) return;
    started.value = true;

    let channel: RealtimeChannel | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    /** Each duel announces itself once, however many pushes its row produces. */
    const told = new Set<string>();

    const show = (t: DuelToast, sound: 'success' | 'matchFound') => {
      if (told.has(t.key)) return;
      told.add(t.key);
      // Already looking at it: the room or the Battle screen says so itself.
      if (t.duelId && route.path === `/duel/${t.duelId}`) return;
      if (t.kind === 'paired' && route.path === '/duels') return;
      toast.value = t;
      playSound(sound);
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (toast.value?.key === t.key) toast.value = null;
      }, 15_000);
    };

    const visible = () => document.visibilityState === 'visible';

    function poll() {
      if (!me.value || !visible()) return;
      refresh();
    }

    function subscribe(id: string) {
      channel = supabase
        .channel(`duel-signal:${id}`)
        // A challenge sent to me.
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'duels', filter: `opponent_id=eq.${id}` },
          async ({ new: row }: any) => {
            if (row?.status !== 'PENDING') return;
            const res = await refresh();
            const from = res?.latestIncoming?.id === row.id ? res.latestIncoming.from : 'A manager';
            show({
              key: `c:${row.id}`,
              kind: 'challenge',
              title: `${from} challenged you`,
              body: 'A friendly: it does not count anywhere.',
              duelId: row.id,
              to: '/duels',
              action: 'Answer',
            }, 'success');
          },
        )
        /**
         * A challenge of mine being accepted. Every draft step also updates this row, so the
         * push is read for the one transition that matters — a friendly at turn 0, freshly
         * accepted — and remembered so later pushes on the same row are ignored.
         */
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'duels', filter: `challenger_id=eq.${id}` },
          async ({ new: row }: any) => {
            if (row?.status !== 'DRAFTING' || row?.source !== 'CHALLENGE' || row?.turn !== 0) return;
            const acceptedAt = row.accepted_at ? new Date(row.accepted_at).getTime() : 0;
            if (Date.now() - acceptedAt > 120_000) return;
            const res = await refresh();
            show({
              key: `a:${row.id}`,
              kind: 'accepted',
              title: `${res?.liveOpponent || 'They'} accepted your challenge`,
              body: 'The draft is opening. Your clock starts in a moment.',
              duelId: row.id,
              to: `/duel/${row.id}`,
              action: 'Join',
            }, 'matchFound');
          },
        )
        // Paired by the queue while not on the Battle screen (a second tab, say).
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'duel_queue', filter: `profile_id=eq.${id}` },
          async ({ new: row }: any) => {
            if (!row?.duel_id) return;
            const res = await refresh();
            show({
              key: `p:${row.duel_id}`,
              kind: 'paired',
              title: 'Match found',
              body: `You are drafting against ${res?.liveOpponent || 'another manager'}.`,
              duelId: row.duel_id,
              to: `/duel/${row.duel_id}`,
              action: 'Join',
            }, 'matchFound');
          },
        )
        .subscribe();
    }

    function stopAll() {
      clearInterval(timer);
      timer = undefined;
      if (channel) {
        supabase.removeChannel(channel);
        channel = null;
      }
    }

    // Signed in: listen and poll. Signed out: neither, and forget what the last account had.
    watch(me, (id) => {
      stopAll();
      if (!id) {
        incoming.value = 0;
        drafting.value = 0;
        liveDuelId.value = null;
        toast.value = null;
        return;
      }
      refresh();
      subscribe(id);
      timer = setInterval(poll, POLL_MS);
    }, { immediate: true });

    // Catch up straight away when someone comes back to the tab, which is exactly when a
    // challenge that arrived while they were away should appear.
    document.addEventListener('visibilitychange', () => {
      if (visible()) poll();
    });

    return stopAll;
  }

  return { incoming, drafting, liveDuelId, toast, dismiss, refresh, start };
}
