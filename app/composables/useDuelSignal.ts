/**
 * What the duel part of the game wants from you, shared across every screen.
 *
 * Two different things, and the second one is new. A challenge is the one thing in the game
 * that arrives without you doing anything, so it needs telling. A *live room* is stronger
 * than that: if you are mid-draft and looking at your collection, the nav should not say
 * "1 duel" — it should offer to put you back, because somebody is sitting on the other side
 * of that draft watching your clock run down.
 *
 * Polled, slowly, and deliberately so. This is a badge: a room appearing in the nav twenty
 * seconds late costs nobody anything, and the room itself holds a realtime subscription the
 * moment you are in it. Subscribing from the layout to every duel a manager might ever have
 * would be a channel per screen for the sake of a dot.
 */
export function useDuelSignal() {
  const incoming = useState('duel-incoming', () => 0);
  const drafting = useState('duel-drafting', () => 0);
  /** The room to be put back into, if there is one. */
  const liveDuelId = useState<string | null>('duel-live-id', () => null);
  const liveStatus = useState<string | null>('duel-live-status', () => null);
  const started = useState('duel-polling', () => false);

  async function refresh() {
    try {
      const res = await $fetch<{
        incoming: number;
        drafting: number;
        liveDuelId: string | null;
        liveStatus: string | null;
      }>('/api/duel/pending');
      incoming.value = res.incoming;
      drafting.value = res.drafting;
      liveDuelId.value = res.liveDuelId;
      liveStatus.value = res.liveStatus;
    } catch {
      // Signed out, offline, or the migration has not been run. A badge is not worth an error.
    }
  }

  /** Starts once per session, from the layout, and only in the browser. */
  function start() {
    if (started.value || import.meta.server) return;
    started.value = true;
    refresh();
    const timer = setInterval(refresh, 20000);
    if (import.meta.client) {
      // Catch up straight away when someone comes back to the tab, which is exactly when a
      // challenge that arrived while they were away should appear.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refresh();
      });
    }
    return () => clearInterval(timer);
  }

  return { incoming, drafting, liveDuelId, liveStatus, refresh, start };
}
