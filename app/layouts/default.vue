<script setup lang="ts">
import type { Gift } from '~/composables/useGiftSignal';

const user = useSupabaseUser();
const route = useRoute();
const { packReady } = usePackSignal();
const { credits, start: startWallet } = useWallet();
const focus = useFocusMode();

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
  startWallet();
}, { immediate: true });

/**
 * The arrival toast.
 *
 * Held in a local ref rather than read straight off `unseenGifts`, because it is marked seen
 * the moment it is shown: the announcement happens once, and the gift itself keeps announcing
 * itself through the Home dot and the call-out on the pack screen until it is opened.
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
const battleCount = computed(() => incoming.value || drafting.value || 0);
const homeDot = computed(() => packReady.value || giftsWaiting.value > 0);

/** A duel room is a full-screen place with its own way out; so is a reveal in progress. */
const isFocus = computed(() => focus.value || route.path.startsWith('/duel/'));

/** Pages that belong to a tab without being its root still light the tab up. */
const inBattle = computed(() => route.path.startsWith('/duel') || route.path === '/discovery' || route.path.startsWith('/m/'));
const inLeague = computed(() => route.path.startsWith('/leagues') || route.path.startsWith('/join'));
const inCards = computed(() => route.path.startsWith('/card'));

const initial = computed(() => (user.value?.email || '?').slice(0, 1));
</script>

<template>
  <div class="shell" :class="{ 'is-focus': isFocus }">
    <svg width="0" height="0" style="position:absolute" aria-hidden="true">
      <defs>
        <symbol id="lom-logo" viewBox="0 0 28 28"><path d="M14 2l12 12-12 12L2 14z" fill="none" stroke="#d8b064" stroke-width="1.6" /><path d="M14 7.5L20.5 14 14 20.5 7.5 14z" fill="#d8b064" /></symbol>
        <symbol id="nav-home" viewBox="0 0 24 24"><path d="M4 10.5L12 4l8 6.5V20h-5.5v-5.5h-5V20H4z" /></symbol>
        <symbol id="nav-cards" viewBox="0 0 24 24"><rect x="8" y="3.5" width="11" height="15" rx="1.5" /><path d="M5.5 6.5v12A2 2 0 0 0 7.5 20.5H15" /></symbol>
        <symbol id="nav-battle" viewBox="0 0 24 24"><path d="M5 4l9.5 9.5M19 4l-9.5 9.5M7.5 14.5l2 2M16.5 14.5l-2 2M4.5 17.5l2 2M19.5 17.5l-2 2M5 4h3.5M5 4v3.5M19 4h-3.5M19 4v3.5" /></symbol>
        <symbol id="nav-league" viewBox="0 0 24 24"><path d="M7 4h10v4.5a5 5 0 0 1-10 0zM7 6H4.5a2.5 2.5 0 0 0 2.6 3.4M17 6h2.5a2.5 2.5 0 0 1-2.6 3.4M12 13.5V17M8.5 20h7l-1-3h-5z" /></symbol>
        <symbol id="nav-team" viewBox="0 0 24 24"><circle cx="12" cy="5.5" r="2" /><circle cx="5" cy="10.5" r="2" /><circle cx="19" cy="10.5" r="2" /><circle cx="8" cy="18.5" r="2" /><circle cx="16" cy="18.5" r="2" /></symbol>
      </defs>
    </svg>

    <header v-if="user && !isFocus" class="appbar">
      <NuxtLink class="logo" to="/pack" aria-label="LOM home">
        <svg aria-hidden="true"><use href="#lom-logo" /></svg><b>LOM</b>
      </NuxtLink>

      <nav class="deskNav" aria-label="Main">
        <NuxtLink to="/pack">Home</NuxtLink>
        <NuxtLink to="/collection" :class="{ 'router-link-active': inCards }">Cards</NuxtLink>
        <NuxtLink :to="battleTo" :class="{ 'router-link-active': inBattle, 'is-live': liveDuelId }">
          {{ liveDuelId ? 'Live' : 'Battle' }}
          <span v-if="battleCount" class="count">{{ battleCount }}</span>
        </NuxtLink>
        <NuxtLink to="/leagues" :class="{ 'router-link-active': inLeague }">League</NuxtLink>
        <NuxtLink to="/roster">Team</NuxtLink>
        <NuxtLink to="/shop">Shop</NuxtLink>
      </nav>

      <div class="appbar__end">
        <NuxtLink class="credits" to="/shop" :aria-label="`${credits ?? 0} credits, open the shop`">
          <i class="coin" aria-hidden="true" />{{ credits === null ? '—' : credits.toLocaleString('en') }}
        </NuxtLink>
        <NuxtLink class="avatar" to="/profile" aria-label="Your profile">{{ initial }}</NuxtLink>
      </div>
    </header>

    <slot />

    <!-- A gift arrived. Said once, politely, wherever the manager happens to be. -->
    <Transition name="gift">
      <aside v-if="toast" class="gifttoast" role="status" aria-live="polite">
        <span class="gifttoast__mark" aria-hidden="true"><i class="tag tag--new">Gift</i></span>
        <span class="gifttoast__text">
          <strong>{{ toast.title }}</strong>
          <span v-if="toast.body" class="gifttoast__body">{{ toast.body }}</span>
        </span>
        <NuxtLink class="btn btn--sm" to="/shop" @click="toast = null">Open</NuxtLink>
        <button class="icon-btn" type="button" aria-label="Dismiss" @click="toast = null">
          <svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </aside>
    </Transition>

    <nav v-if="user" class="tabbar" aria-label="Main">
      <NuxtLink to="/pack">
        <svg class="ico" aria-hidden="true"><use href="#nav-home" /></svg>
        Home
        <span v-if="homeDot" class="tabbar__dot" aria-hidden="true" />
      </NuxtLink>
      <NuxtLink to="/collection" :class="{ 'router-link-active': inCards }">
        <svg class="ico" aria-hidden="true"><use href="#nav-cards" /></svg>
        Cards
      </NuxtLink>
      <NuxtLink
        :to="battleTo" class="tabbar__play"
        :class="{ 'router-link-active': inBattle, 'is-live': liveDuelId }"
      >
        <span class="diamond"><svg class="ico" aria-hidden="true"><use href="#nav-battle" /></svg></span>
        {{ liveDuelId ? 'Live' : 'Battle' }}
        <span v-if="battleCount" class="count" aria-hidden="true">{{ battleCount }}</span>
      </NuxtLink>
      <NuxtLink to="/leagues" :class="{ 'router-link-active': inLeague }">
        <svg class="ico" aria-hidden="true"><use href="#nav-league" /></svg>
        League
      </NuxtLink>
      <NuxtLink to="/roster">
        <svg class="ico" aria-hidden="true"><use href="#nav-team" /></svg>
        Team
      </NuxtLink>
    </nav>
  </div>
</template>

<style scoped>
/* Above the nav, never over it: an announcement, not a modal. */
.gifttoast {
  position: fixed;
  left: 12px;
  right: 12px;
  bottom: calc(var(--nav-h) + env(safe-area-inset-bottom, 0px) + 12px);
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 520px;
  margin-inline: auto;
  padding: 10px 6px 10px 14px;
  border: 1px solid rgba(216, 176, 100, 0.4);
  border-radius: var(--radius);
  background: var(--bg-3);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.5);
}
.gifttoast__mark { flex: none; }
.gifttoast__text { flex: 1; min-width: 0; font-size: 14px; line-height: 1.35; }
.gifttoast__text strong { display: block; font-weight: 680; }
.gifttoast__body {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  margin-top: 2px;
  color: var(--ink-2);
  font-size: 12.5px;
}
.gifttoast .icon-btn svg { width: 18px; height: 18px; }

@media (min-width: 1024px) {
  .gifttoast { left: auto; right: 24px; bottom: 24px; }
}

.gift-enter-active { transition: opacity 0.24s var(--ease-out), transform 0.24s var(--ease-out); }
.gift-leave-active { transition: opacity 0.18s ease, transform 0.18s ease; }
.gift-enter-from, .gift-leave-to { opacity: 0; transform: translateY(10px); }

@media (prefers-reduced-motion: reduce) {
  .gift-enter-active, .gift-leave-active { transition: opacity 0.15s linear; }
  .gift-enter-from, .gift-leave-to { transform: none; }
}
</style>
