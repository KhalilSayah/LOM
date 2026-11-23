/**
 * Wires sound to the whole interface in one place.
 *
 * - The first gesture unlocks audio (browsers refuse to play before one).
 * - A delegated click listener gives every control its voice: `data-sound="name"` on an
 *   element (or an ancestor) picks a specific sound, `data-sound="none"` silences it, and
 *   otherwise buttons tap, tabs and filters tick. Screens add the moments that are theirs —
 *   a reveal, a lock-in, a win — where they happen.
 */
import { unlockAudio, resumeAudio, playSound, type SoundName } from '~/composables/useSound';

export default defineNuxtPlugin(() => {
  /**
   * Every kind of gesture unlocks, and keeps unlocking. Mobile browsers disagree about which
   * event counts as "user activation" for audio (iOS Safari accepts touchend and click but
   * not always pointerdown), and iOS re-suspends — or marks 'interrupted' — the context after
   * a call or a trip to another app, so the next tap has to be able to wake it again.
   * unlockAudio is a no-op once the context is running.
   */
  const unlock = () => unlockAudio();
  for (const type of ['pointerdown', 'pointerup', 'touchend', 'click'] as const) {
    window.addEventListener(type, unlock, { passive: true, capture: true });
  }
  window.addEventListener('keydown', unlock, { capture: true });

  // Back to the tab: resume where the browser allows it without a gesture (desktop does).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resumeAudio();
  });
  window.addEventListener('pageshow', () => resumeAudio());

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest) return;

    const tagged = target.closest<HTMLElement>('[data-sound]');
    if (tagged) {
      const name = tagged.dataset.sound;
      if (name && name !== 'none') playSound(name as SoundName);
      return;
    }

    const control = target.closest<HTMLElement>('button, a');
    if (!control || (control as HTMLButtonElement).disabled) return;

    if (control.closest('.tabbar, .deskNav, .navmenu')) return playSound('tick');
    if (control.matches('.chip, .seg button, .champ')) return playSound('select');
    if (control.matches('.btn, .icon-btn, .credits')) return playSound('tap');
  }, { capture: true });
});
