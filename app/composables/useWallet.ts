/**
 * What the chrome needs to know about the manager, fetched once and shared.
 *
 * The credits pill sits in the brand bar on every screen, and the pack dot sits on the Home
 * tab, so neither can wait for the pack screen to be visited. One read of /api/pack/status at
 * sign-in fills both; the pack and shop screens write back the fresher numbers they load
 * themselves, so the pill never disagrees with the screen under it.
 */
export function useWallet() {
  const credits = useState<number | null>('wallet-credits', () => null);
  const started = useState('wallet-started', () => false);
  const { packReady, packsWaiting, questsReady } = usePackSignal();

  async function refresh() {
    try {
      const status = await $fetch<{
        credits: number;
        available: boolean;
        waiting?: number;
        quests?: { claimable: number };
      }>('/api/pack/status');
      credits.value = status.credits;
      packReady.value = status.available;
      packsWaiting.value = status.waiting ?? (status.available ? 1 : 0);
      questsReady.value = status.quests?.claimable ?? 0;
    } catch {
      // Signed out or offline: the pill just stays empty.
    }
  }

  function start() {
    if (started.value || import.meta.server) return;
    started.value = true;
    refresh();
  }

  return { credits, refresh, start };
}

/**
 * Full-screen moments — the reveal, the draft, the live match — hide the tab bar so the
 * thing happening has the whole screen and nothing to mis-tap under a thumb.
 */
export function useFocusMode() {
  return useState('focus-mode', () => false);
}
