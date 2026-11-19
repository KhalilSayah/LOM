/**
 * How many duels want something from you, shared across every screen.
 *
 * A challenge is the one thing in the game that arrives without you doing anything, so it
 * is the one thing that needs telling. The nav polls this rather than each screen asking,
 * and slowly — a duel sitting unanswered for twenty seconds longer costs nobody anything,
 * and the draft itself does its own polling once you are in it.
 */
export function useDuelSignal() {
  const incoming = useState('duel-incoming', () => 0);
  const drafting = useState('duel-drafting', () => 0);
  const started = useState('duel-polling', () => false);

  async function refresh() {
    try {
      const res = await $fetch<{ incoming: number; drafting: number }>('/api/duel/pending');
      incoming.value = res.incoming;
      drafting.value = res.drafting;
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
      // Catch up straight away when someone comes back to the tab, which is exactly when
      // a challenge that arrived while they were away should appear.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refresh();
      });
    }
    return () => clearInterval(timer);
  }

  return { incoming, drafting, refresh, start };
}
