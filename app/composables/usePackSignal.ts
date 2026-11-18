/**
 * One shared "a pack is waiting" flag, so the bottom nav can show a dot without every
 * screen hitting /api/pack/status on its own.
 */
export function usePackSignal() {
  const packReady = useState('pack-ready', () => false);
  return { packReady };
}
