<script setup lang="ts">
import type { Gift } from '~/composables/useGiftSignal';

const user = useSupabaseUser();
const { packReady } = usePackSignal();

// A challenge arrives without you doing anything, so the nav has to say so — and a room you
// are already in has somebody on the other side of it, so the nav links straight back into it
// rather than to the list.
const { incoming, drafting, liveDuelId, start } = useDuelSignal();

// A gift arrives the same way: nobody asked for it, so it has to say so itself.
const {
  waiting: giftsWaiting,
  unseen: unseenGifts,
  markSeen,
  start: startGifts,
} = useGiftSignal();

watch(user, (u) => {
  if (!u) return;
  start();
  startGifts();
}, { immediate: true });

/**
 * The arrival toast.
 *
 * Held in a local ref rather than read straight off `unseenGifts`, because it is marked seen
 * the moment it is shown: the announcement happens once, and the gift itself keeps announcing
 * itself through the nav dot and the call-out on the pack screen until it is opened.
 */
const toast = ref<Gift | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;

watch(unseenGifts, (list) => {
  if (toast.value || !list.length) return;
  toast.value = list[0]!;
  markSeen([list[0]!.id]);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = null; }, 12000);
}, { immediate: true });

onBeforeUnmount(() => clearTimeout(toastTimer));

const battleTo = computed(() => (liveDuelId.value ? `/duel/${liveDuelId.value}` : '/duels'));
</script>

<template>
  <div class="shell">
    <slot />

    <!-- A gift arrived. Said once, politely, wherever the manager happens to be. -->
    <Transition name="gift">
      <aside v-if="toast" class="gifttoast" role="status" aria-live="polite">
        <span class="gifttoast__mark" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M3 7h18v3H3zM4 11h16v9H4zm6 0h4v9h-4z"/></svg>
        </span>
        <span class="gifttoast__text">
          <strong>{{ toast.title }}</strong>
          <span v-if="toast.body" class="gifttoast__body">{{ toast.body }}</span>
        </span>
        <NuxtLink class="gifttoast__go" to="/shop" @click="toast = null">Open</NuxtLink>
        <button class="gifttoast__close" type="button" aria-label="Dismiss" @click="toast = null">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
        </button>
      </aside>
    </Transition>

    <nav v-if="user" class="nav" aria-label="Main">
      <NuxtLink to="/pack">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h18v3H3zM4 11h16v9H4zm6 0h4v9h-4z"/></svg>
        Pack
        <span v-if="packReady || giftsWaiting" class="nav__dot" aria-hidden="true" />
      </NuxtLink>
      <NuxtLink to="/collection">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h7v8H4zm9 0h7v5h-7zM4 13h7v8H4zm9-3h7v11h-7z"/></svg>
        Cards
      </NuxtLink>
      <NuxtLink to="/roster">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3.2 3.2 0 1 0 0 6.4A3.2 3.2 0 0 0 12 3ZM5 10.5a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Zm14 0a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2ZM12 11c-2.9 0-5.2 1.7-5.2 3.8V21h10.4v-6.2c0-2.1-2.3-3.8-5.2-3.8ZM5 12c-2.2 0-4 1.3-4 3V21h3.8v-6.2c0-1 .4-2 1.1-2.7A5 5 0 0 0 5 12Zm14 0c-.3 0-.6 0-.9.1.7.7 1.1 1.7 1.1 2.7V21H23v-6c0-1.7-1.8-3-4-3Z"/></svg>
        Roster
      </NuxtLink>
      <NuxtLink to="/discovery">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm3.9 6.1-2.2 5-5 2.2 2.2-5 5-2.2ZM12 11a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"/></svg>
        Discover
      </NuxtLink>
      <NuxtLink :to="battleTo" :class="{ 'is-live': liveDuelId }">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.9 3 3 6.9l9.1 9.1 1.4-1.4-1.1-1.1 1.4-1.4 1.1 1.1 1.4-1.4L6.9 3Zm10.2 0L13 7.1l1.4 1.4 1.1-1.1 1.4 1.4-1.1 1.1 1.4 1.4L21 6.9 17.1 3ZM4.5 17.1 3 18.6 5.4 21l1.5-1.5-2.4-2.4Zm15 0-2.4 2.4L18.6 21 21 18.6l-1.5-1.5Z"/></svg>
        {{ liveDuelId ? 'Live' : 'Battle' }}
        <span v-if="incoming || drafting" class="nav__count" aria-hidden="true">{{ incoming || drafting }}</span>
      </NuxtLink>
      <NuxtLink to="/profile">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 2c-4.4 0-8 2.5-8 5.5V21h16v-1.5c0-3-3.6-5.5-8-5.5Z"/></svg>
        Profile
      </NuxtLink>
    </nav>
  </div>
</template>

<style scoped>
/*
 * Above the nav, never over it: the toast is an announcement, not a modal, and it must not
 * sit on top of the thing it is telling you to go and tap.
 */
.gifttoast {
  position: fixed;
  left: 12px;
  right: 12px;
  bottom: calc(var(--nav-h) + env(safe-area-inset-bottom, 0px) + 12px);
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 11px;
  max-width: 560px;
  margin-inline: auto;
  padding: 12px 12px 12px 13px;
  border: 1px solid var(--line-strong);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius);
  background: color-mix(in oklab, var(--surface) 92%, var(--accent));
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
}

.gifttoast__mark {
  flex: none;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--accent);
  color: var(--accent-ink);
}
.gifttoast__mark svg { width: 17px; height: 17px; fill: currentColor; }

.gifttoast__text { flex: 1; min-width: 0; font-size: 13.5px; line-height: 1.35; }
.gifttoast__text strong { display: block; }
/* Two lines is an announcement; four is a letter. The shop shows the whole thing. */
.gifttoast__body {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  margin-top: 2px;
  color: var(--ink-dim);
  font-size: 12.5px;
}

.gifttoast__go {
  flex: none;
  align-self: stretch;
  display: grid;
  place-items: center;
  padding: 0 13px;
  border-radius: 8px;
  background: var(--accent);
  color: var(--accent-ink);
  font-family: var(--font-label);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  text-decoration: none;
}

.gifttoast__close {
  flex: none;
  appearance: none;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ink-faint);
  cursor: pointer;
}
.gifttoast__close svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
}
.gifttoast__close:hover { color: var(--ink); }

.gift-enter-active, .gift-leave-active { transition: opacity 0.22s ease, transform 0.22s ease; }
.gift-enter-from, .gift-leave-to { opacity: 0; transform: translateY(10px); }

@media (prefers-reduced-motion: reduce) {
  .gift-enter-active, .gift-leave-active { transition: none; }
}
</style>
