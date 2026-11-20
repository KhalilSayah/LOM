/**
 * The gifts waiting for this manager, shared across every screen.
 *
 * A gift arrives without you doing anything — the signup trigger grants one, an operator
 * grants another from the SQL editor — so like a duel challenge it has to announce itself
 * rather than wait to be found. Two different things are wanted from the same list:
 *
 * - `unseen` is the arrival. It drives the one-time toast in the layout, and is cleared the
 *   moment that toast has been shown.
 * - `waiting` is the standing fact that a free pack is unopened. It drives the nav dot and
 *   the call-out on the pack screen, and only clears when the pack is actually opened.
 *
 * Not polled. Nothing grants a gift in the middle of a session except an operator, and a
 * refresh on sign-in and on coming back to the tab catches that soon enough for a badge.
 */

export interface Gift {
  id: string;
  packType: string;
  packName: string;
  slots: number;
  onePerRole: boolean;
  reason: string;
  title: string;
  body: string | null;
  grantedAt: string;
  seen: boolean;
}

export function useGiftSignal() {
  const gifts = useState<Gift[]>('gifts', () => []);
  const started = useState('gift-watching', () => false);

  const waiting = computed(() => gifts.value.length);
  const unseen = computed(() => gifts.value.filter((g) => !g.seen));

  async function refresh() {
    try {
      const res = await $fetch<{ gifts: Gift[] }>('/api/gifts/list');
      gifts.value = res.gifts;
    } catch {
      // Signed out, offline, or the migration has not been run. A badge is not worth an error.
    }
  }

  /** The arrival has been announced. The gift stays in the list until it is opened. */
  async function markSeen(ids: string[]) {
    if (!ids.length) return;
    const announced = new Set(ids);
    gifts.value = gifts.value.map((g) => (announced.has(g.id) ? { ...g, seen: true } : g));
    try {
      await $fetch('/api/gifts/seen', { method: 'POST', body: { ids } });
    } catch {
      // The toast is already gone for this session; it reappearing later is harmless.
    }
  }

  /** Opened. Drop it locally rather than waiting for a round trip to say so. */
  function drop(id: string) {
    gifts.value = gifts.value.filter((g) => g.id !== id);
  }

  /** Starts once per session, from the layout, and only in the browser. */
  function start() {
    if (started.value || import.meta.server) return;
    started.value = true;
    refresh();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refresh();
    });
  }

  return { gifts, waiting, unseen, refresh, markSeen, drop, start };
}
