<script setup lang="ts">
/**
 * A challenge arrived, a challenge was accepted, or the queue found a match — said once,
 * wherever the manager happens to be (useDuelSignal holds the realtime side of it).
 *
 * At the top of the screen rather than the bottom, so it never sits on the gift toast or the
 * tab bar. Not shown inside a duel room: somebody mid-draft has one thing to look at.
 */
const { toast, dismiss } = useDuelSignal();
const route = useRoute();
const hidden = computed(() => route.path.startsWith('/duel/'));
</script>

<template>
  <Transition name="dueltoast">
    <aside v-if="toast && !hidden" class="dueltoast" role="status" aria-live="polite">
      <span class="tag" :class="toast.kind === 'challenge' ? 'tag--new' : 'tag--live'">
        {{ toast.kind === 'challenge' ? 'Challenge' : 'Live' }}
      </span>
      <span class="dueltoast__text">
        <strong>{{ toast.title }}</strong>
        <span class="dueltoast__body">{{ toast.body }}</span>
      </span>
      <NuxtLink class="btn btn--sm" :to="toast.to" @click="dismiss">{{ toast.action }}</NuxtLink>
      <button class="icon-btn" type="button" aria-label="Dismiss" @click="dismiss">
        <svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </aside>
  </Transition>
</template>

<style scoped>
.dueltoast {
  position: fixed;
  top: calc(64px + env(safe-area-inset-top, 0px));
  left: 12px;
  right: 12px;
  z-index: 45;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 520px;
  margin-inline: auto;
  padding: 8px 4px 8px 12px;
  border: 1px solid var(--line-3);
  border-radius: var(--radius);
  background: var(--bg-3);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.5);
}
.dueltoast .tag { flex: none; }
.dueltoast__text { flex: 1; min-width: 0; font-size: 14px; line-height: 1.3; }
.dueltoast__text strong { display: block; font-weight: 680; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dueltoast__body { display: block; margin-top: 2px; color: var(--ink-2); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dueltoast .btn { flex: none; min-height: 44px; }
.dueltoast .icon-btn { flex: none; width: 44px; height: 44px; }
.dueltoast .icon-btn svg { width: 18px; height: 18px; }

@media (min-width: 1024px) {
  .dueltoast { left: auto; right: 24px; top: 76px; }
}

.dueltoast-enter-active { transition: opacity 0.24s var(--ease-out), transform 0.24s var(--ease-out); }
.dueltoast-leave-active { transition: opacity 0.18s ease, transform 0.18s ease; }
.dueltoast-enter-from, .dueltoast-leave-to { opacity: 0; transform: translateY(-10px); }

@media (prefers-reduced-motion: reduce) {
  .dueltoast-enter-active, .dueltoast-leave-active { transition: opacity 0.15s linear; }
  .dueltoast-enter-from, .dueltoast-leave-to { transform: none; }
}
</style>
