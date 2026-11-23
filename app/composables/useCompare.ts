import { effectScope, watch } from 'vue';

/**
 * Two cards pinned side by side.
 *
 * A pin is a snapshot of the card as it was shown — yours, or one from a friend's
 * collection — so the comparison can hold one of each without either page having to stay
 * open. Kept for the browser session, so pinning a card, walking to a friend's page and
 * pinning theirs works across the navigation and a reload, and is gone tomorrow.
 */

export interface PinnedCard {
  /** Unique across sources: "mine:<collection id>" or "<share code>:<collection id>". */
  id: string;
  /** Whose card it is, for the label: null for your own. */
  owner: string | null;
  level?: number;
  card: Record<string, any>;
}

const STORE_KEY = 'lom-compare';
const MAX = 2;

export function useCompare() {
  const pins = useState<PinnedCard[]>('compare:pins', () => []);
  const open = useState<boolean>('compare:open', () => false);
  const hydrated = useState<boolean>('compare:hydrated', () => false);

  if (import.meta.client && !hydrated.value) {
    hydrated.value = true;
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || '[]');
      if (Array.isArray(saved)) pins.value = saved.slice(0, MAX);
    } catch { /* private mode or a corrupt entry: start empty */ }
    // Detached, so the save outlives whichever page happened to hydrate the store.
    effectScope(true).run(() => {
      watch(pins, (list) => {
        try { sessionStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch { /* full or blocked */ }
      }, { deep: true });
    });
  }

  const isPinned = (id: string) => pins.value.some((p) => p.id === id);

  /**
   * Pin or unpin. A third pin replaces the older of the two, which is what someone
   * flicking through candidates against one card wants less often than the reverse —
   * so the card pinned first is the one that goes.
   */
  function toggle(pin: PinnedCard) {
    if (isPinned(pin.id)) {
      pins.value = pins.value.filter((p) => p.id !== pin.id);
      return false;
    }
    const next = [...pins.value, pin];
    pins.value = next.slice(-MAX);
    return true;
  }

  function remove(id: string) {
    pins.value = pins.value.filter((p) => p.id !== id);
    if (pins.value.length < MAX) open.value = false;
  }

  function clear() {
    pins.value = [];
    open.value = false;
  }

  return { pins, open, isPinned, toggle, remove, clear, max: MAX };
}
