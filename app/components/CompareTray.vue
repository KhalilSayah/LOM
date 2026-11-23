<script setup lang="ts">
/**
 * The pinned cards, held at the foot of the screen until there are two to compare.
 *
 * It sits on every screen a card can be pinned from — your Cards, a card page, a friend's
 * collection — so pinning one of yours and then one of theirs is a walk, not a hunt.
 */
const { pins, open, remove, clear, max } = useCompare();

const label = (p: any) => `${p.card.playerName} ${p.card.season ?? ''}`.trim();
</script>

<template>
  <!-- Room at the foot of the page, so the tray never covers the last row of cards. -->
  <div v-if="pins.length" class="tray-spacer" aria-hidden="true" />
  <div v-if="pins.length" class="tray" role="region" aria-label="Cards pinned to compare">
    <ul class="tray__pins">
      <li v-for="(p, i) in pins" :key="p.id" class="tray__pin" :class="i === 0 ? 'is-a' : 'is-b'">
        <span class="tray__key" aria-hidden="true" />
        <span class="tray__name">{{ label(p) }}<small v-if="p.owner"> · {{ p.owner }}</small></span>
        <button class="tray__x" type="button" :aria-label="`Unpin ${label(p)}`" data-sound="toggle" @click="remove(p.id)">
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" /></svg>
        </button>
      </li>
      <li v-if="pins.length < max" class="tray__hint faint">Pin one more card to compare</li>
    </ul>
    <div class="tray__end">
      <button class="btn btn--quiet" type="button" data-sound="back" @click="clear">Clear</button>
      <button class="btn btn--ghost btn--sm" type="button" :disabled="pins.length < max" @click="open = true">Compare</button>
    </div>
  </div>
  <CardCompare />
</template>

<style scoped>
.tray-spacer { height: 110px; }
.tray {
  position: fixed;
  z-index: 40;
  left: 50%;
  bottom: calc(var(--nav-h) + env(safe-area-inset-bottom, 0px) + 10px);
  transform: translateX(-50%);
  width: min(calc(100% - 20px), 640px);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  padding: 8px 8px 8px 12px;
  background: rgba(12, 18, 30, 0.97);
  border: 1px solid var(--line-2);
  border-radius: var(--radius);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5);
}
@media (min-width: 1024px) { .tray { bottom: 20px; } }

.tray__pins { list-style: none; margin: 0; padding: 0; flex: 1 1 260px; min-width: 0; display: grid; gap: 2px; }
.tray__pin { display: flex; align-items: center; gap: 8px; min-width: 0; }
.tray__key { flex: none; width: 16px; height: 0; border-top: 2px solid var(--gold-2); }
.is-b .tray__key { border-top: 2px dashed var(--blue-2); }
.tray__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; font-weight: 680; }
.tray__name small { font-weight: 500; color: var(--ink-3); }
.tray__x { appearance: none; display: grid; place-items: center; width: 36px; height: 36px; flex: none; border: 0; background: none; color: var(--ink-3); cursor: pointer; }
.tray__x svg { width: 18px; height: 18px; }
.tray__x:hover { color: var(--ink-1); }
.tray__hint { font-size: 12.5px; padding: 4px 0 4px 24px; }
.tray__end { display: flex; gap: 6px; margin-left: auto; }
@media (pointer: coarse) { .tray__x { width: 44px; height: 44px; } }
</style>
