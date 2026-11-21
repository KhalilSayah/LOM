/**
 * Shared "something is waiting on Home" flags, so the nav can show a dot without every
 * screen hitting /api/pack/status on its own.
 *
 * - `packReady`: at least one daily pack is waiting (today's, or one banked from before).
 * - `packsWaiting`: how many, up to the bank's cap of three.
 * - `questsReady`: quests finished and not yet collected, daily and weekly together.
 *
 * All three are filled by useWallet().refresh() from one status read, and written back by
 * the Home and quests screens when they load something fresher.
 */
export function usePackSignal() {
  const packReady = useState('pack-ready', () => false);
  const packsWaiting = useState('packs-waiting', () => 0);
  const questsReady = useState('quests-ready', () => 0);
  return { packReady, packsWaiting, questsReady };
}

/** The quest half of the signal, for a nav dot or badge. */
export function useQuestSignal() {
  const { questsReady } = usePackSignal();
  return { questsReady };
}
