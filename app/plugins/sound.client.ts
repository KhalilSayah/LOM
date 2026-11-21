/**
 * Wires sound to the whole interface in one place.
 *
 * - The first gesture unlocks audio (browsers refuse to play before one).
 * - A delegated click listener gives every control its voice: `data-sound="name"` on an
 *   element (or an ancestor) picks a specific sound, `data-sound="none"` silences it, and
 *   otherwise buttons tap, tabs and filters tick. Screens add the moments that are theirs —
 *   a reveal, a lock-in, a win — where they happen.
 */
import { unlockAudio, playSound, type SoundName } from '~/composables/useSound';

export default defineNuxtPlugin(() => {
  const unlock = () => unlockAudio();
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);

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

    if (control.closest('.tabbar, .deskNav')) return playSound('tick');
    if (control.matches('.chip, .seg button, .champ')) return playSound('select');
    if (control.matches('.btn, .icon-btn, .credits')) return playSound('tap');
  }, { capture: true });
});
