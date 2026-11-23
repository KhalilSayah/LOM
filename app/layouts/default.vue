<script setup lang="ts">
import type { Gift } from '~/composables/useGiftSignal';

const user = useSupabaseUser();
const supabase = useSupabaseClient();
const route = useRoute();
const { packReady, questsReady } = usePackSignal();
const { credits, start: startWallet } = useWallet();
const focus = useFocusMode();
const { enabled: soundOn, setEnabled: setSound } = useSound();
const signOut = useSignOut();

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

/** Who the avatar is: read once per session, for the initial and the menu's header. */
const me = useState<{ handle: string; displayName: string } | null>('me-profile', () => null);
async function loadMe() {
  try {
    me.value = (await $fetch<{ profile: any }>('/api/profile/me')).profile;
  } catch { /* the avatar falls back to the email's initial */ }
}

watch(user, async (u, prev) => {
  if (u) {
    start();
    startGifts();
    startWallet();
    if (!me.value && import.meta.client) loadMe();
    return;
  }
  /**
   * Signed out underneath us — another tab, an expired refresh token. Everything the chrome
   * started for the previous account (its polls, its credits, its gifts) belongs to that
   * account, so the app is reset rather than left running signed-out. Checked against the
   * stored session first, so a transient failure to read the claims does not throw anyone
   * out.
   */
  if (prev && import.meta.client) {
    const { data } = await supabase.auth.getSession();
    if (!data.session) resetApp('/');
  }
}, { immediate: true });

/**
 * The arrival toast.
 *
 * Held in a local ref rather than read straight off `unseenGifts`, because it is marked seen
 * the moment it is shown: the announcement happens once, and the gift itself keeps announcing
 * itself through the Home dot and the call-out on the pack screen until it is opened.
 *
 * Screen readers hear it through a live region that is always in the page (below); a region
 * inserted with its text already inside is often not announced at all.
 */
const toast = ref<Gift | null>(null);
const announcement = ref('');
let toastTimer: ReturnType<typeof setTimeout> | undefined;

watch(unseenGifts, (list) => {
  if (toast.value || !list.length) return;
  toast.value = list[0]!;
  playSound('gift');
  markSeen([list[0]!.id]);
  announcement.value = '';
  nextTick(() => { announcement.value = `Gift: ${list[0]!.title}. Open it from the shop.`; });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = null; }, 12000);
}, { immediate: true });

onBeforeUnmount(() => clearTimeout(toastTimer));

const battleTo = computed(() => (liveDuelId.value ? `/duel/${liveDuelId.value}` : '/duels'));
const battleCount = computed(() => incoming.value || drafting.value || 0);
// Home shows the daily pack and the way to the shop, where gifts open. Quests live in the menu.
const homeDot = computed(() => packReady.value || giftsWaiting.value > 0);

/** A duel room is a full-screen place with its own way out; so is a reveal in progress. */
const isFocus = computed(() => focus.value || route.path.startsWith('/duel/'));

/** Pages that belong to a tab without being its root still light the tab up. */
const inBattle = computed(() => route.path.startsWith('/duel') || route.path === '/discovery' || route.path.startsWith('/m/'));
const inLeague = computed(() => route.path.startsWith('/leagues') || route.path.startsWith('/join'));
const inCards = computed(() => route.path.startsWith('/card'));
const inTeamDesk = computed(() => route.path.startsWith('/roster') || route.path.startsWith('/replay'));
// The phone bar has no Sponsors tab, so there Sponsors belongs to Team.
const inTeam = computed(() => inTeamDesk.value || route.path.startsWith('/sponsors'));

const initial = computed(() => (me.value?.displayName || me.value?.handle || user.value?.email || '?').slice(0, 1));

// --- the avatar menu: everything that is not a tab -------------------------------------

const MENU = [
  { to: '/wallet', label: 'Wallet', hint: 'Credits in and out' },
  { to: '/quests', label: 'Quests', hint: 'Goals that pay' },
  { to: '/shop', label: 'Shop', hint: 'Packs' },
  { to: '/sponsors', label: 'Sponsors', hint: 'Contracts that pay per match' },
  { to: '/profile', label: 'Profile', hint: 'Your name, code and collection' },
  { to: '/settings', label: 'Settings', hint: 'Password, sound, motion' },
  { to: '/how-to-play', label: 'How to play', hint: 'The loop in five steps' },
] as const;

const menuOpen = ref(false);
const menuBtn = ref<HTMLButtonElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);

function openMenu() {
  menuOpen.value = true;
  nextTick(() => menuEl.value?.querySelector<HTMLElement>('a, button')?.focus());
}
function closeMenu(returnFocus = false) {
  if (!menuOpen.value) return;
  menuOpen.value = false;
  if (returnFocus) nextTick(() => menuBtn.value?.focus());
}
function toggleMenu() {
  if (menuOpen.value) closeMenu();
  else openMenu();
}
function onMenuKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
}
function onDocPointer(e: PointerEvent) {
  if (!menuOpen.value) return;
  const t = e.target as Node | null;
  if (t && (menuEl.value?.contains(t) || menuBtn.value?.contains(t))) return;
  closeMenu();
}
onMounted(() => document.addEventListener('pointerdown', onDocPointer, true));
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointer, true));
watch(() => route.fullPath, () => closeMenu());
watch(isFocus, (f) => { if (f) closeMenu(); });

const leaving = ref(false);
async function leave() {
  leaving.value = true;
  await signOut();
}
</script>

<template>
  <div class="shell" :class="{ 'is-focus': isFocus, 'has-nav': !!user && !isFocus }">
    <a class="skiplink" href="#content">Skip to content</a>

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
      <NuxtLink class="logo" to="/pack" aria-label="LOM, League of Managers, home">
        <svg aria-hidden="true"><use href="#lom-logo" /></svg><span class="logo__txt"><b>LOM</b><small>League of Managers</small></span>
      </NuxtLink>

      <nav class="deskNav" aria-label="Main">
        <NuxtLink to="/pack">Home</NuxtLink>
        <NuxtLink to="/collection" :class="{ 'router-link-active': inCards }" :aria-current="inCards ? 'page' : undefined">Cards</NuxtLink>
        <NuxtLink
          :to="battleTo" :class="{ 'router-link-active': inBattle, 'is-live': liveDuelId }"
          :aria-current="inBattle ? 'page' : undefined"
        >
          {{ liveDuelId ? 'Live' : 'Battle' }}
          <span v-if="battleCount" class="count" aria-hidden="true">{{ battleCount }}</span>
          <span v-if="battleCount" class="sr-only">, {{ battleCount }} waiting</span>
        </NuxtLink>
        <NuxtLink to="/leagues" :class="{ 'router-link-active': inLeague }" :aria-current="inLeague ? 'page' : undefined">League</NuxtLink>
        <NuxtLink to="/roster" :class="{ 'router-link-active': inTeamDesk }" :aria-current="inTeamDesk ? 'page' : undefined">Team</NuxtLink>
        <NuxtLink to="/sponsors">Sponsors</NuxtLink>
        <NuxtLink to="/shop">Shop</NuxtLink>
      </nav>

      <div class="appbar__end">
        <ClientOnly>
          <button
            class="icon-btn appbar__sound" type="button" data-sound="none"
            :aria-pressed="soundOn" aria-label="Game sounds"
            :title="soundOn ? 'Mute sounds' : 'Turn sounds on'"
            @click="setSound(!soundOn)"
          >
            <svg v-if="soundOn" class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z M15.5 9a4 4 0 0 1 0 6 M18 6.5a7.5 7.5 0 0 1 0 11" /></svg>
            <svg v-else class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z M16 9.5l5 5 M21 9.5l-5 5" /></svg>
          </button>
        </ClientOnly>
        <NuxtLink class="credits" to="/wallet" :aria-label="`${credits ?? 0} credits, open your wallet`">
          <i class="coin" aria-hidden="true" />{{ credits === null ? '—' : credits.toLocaleString('en') }}
        </NuxtLink>

        <div class="menuwrap">
          <button
            ref="menuBtn" class="avatar" type="button" data-sound="tick"
            aria-haspopup="true" :aria-expanded="menuOpen" aria-controls="navmenu"
            aria-label="Your account and more"
            @click="toggleMenu" @keydown="onMenuKey"
          >{{ initial }}<span v-if="questsReady" class="avatar__dot" aria-hidden="true" /><span v-if="questsReady" class="sr-only">, quests ready to collect</span></button>

          <Transition name="menu">
            <nav
              v-if="menuOpen" id="navmenu" ref="menuEl" class="navmenu"
              aria-label="Account and more" @keydown="onMenuKey"
            >
              <p v-if="me" class="navmenu__who">
                <b>{{ me.displayName }}</b><span class="faint">@{{ me.handle }}</span>
              </p>
              <ul>
                <li v-for="item in MENU" :key="item.to">
                  <NuxtLink :to="item.to" @click="closeMenu()">
                    <span>{{ item.label }}<i v-if="item.to === '/quests' && questsReady" class="count navmenu__count">{{ questsReady }}</i></span><small class="faint">{{ item.hint }}</small>
                  </NuxtLink>
                </li>
              </ul>
              <button class="navmenu__out" type="button" data-sound="back" :disabled="leaving" @click="leave">
                {{ leaving ? 'Signing out' : 'Sign out' }}
              </button>
            </nav>
          </Transition>
        </div>
      </div>
    </header>

    <div id="content" class="shell__content" tabindex="-1">
      <slot />
    </div>

    <!-- Always present, so the gift is announced when its text arrives. -->
    <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ announcement }}</div>

    <ClientOnly><DuelToast /></ClientOnly>

    <!-- A gift arrived. Said once, politely, wherever the manager happens to be. -->
    <Transition name="gift">
      <aside v-if="toast && !isFocus" class="gifttoast" aria-label="Gift">
        <span class="gifttoast__mark" aria-hidden="true"><i class="tag tag--new">Gift</i></span>
        <span class="gifttoast__text">
          <strong>{{ toast.title }}</strong>
          <span v-if="toast.body" class="gifttoast__body">{{ toast.body }}</span>
        </span>
        <NuxtLink class="btn btn--gold btn--sm" to="/shop" @click="toast = null">Open</NuxtLink>
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
        <span v-if="homeDot" class="sr-only">, something new</span>
      </NuxtLink>
      <NuxtLink to="/collection" :class="{ 'router-link-active': inCards }" :aria-current="inCards ? 'page' : undefined">
        <svg class="ico" aria-hidden="true"><use href="#nav-cards" /></svg>
        Cards
      </NuxtLink>
      <NuxtLink
        :to="battleTo" class="tabbar__play"
        :class="{ 'router-link-active': inBattle, 'is-live': liveDuelId }"
        :aria-current="inBattle ? 'page' : undefined"
      >
        <span class="diamond"><svg class="ico" aria-hidden="true"><use href="#nav-battle" /></svg></span>
        {{ liveDuelId ? 'Live' : 'Battle' }}
        <span v-if="battleCount" class="count" aria-hidden="true">{{ battleCount }}</span>
        <span v-if="battleCount" class="sr-only">, {{ battleCount }} waiting</span>
      </NuxtLink>
      <NuxtLink to="/leagues" :class="{ 'router-link-active': inLeague }" :aria-current="inLeague ? 'page' : undefined">
        <svg class="ico" aria-hidden="true"><use href="#nav-league" /></svg>
        League
      </NuxtLink>
      <NuxtLink to="/roster" :class="{ 'router-link-active': inTeam }" :aria-current="inTeam ? 'page' : undefined">
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
.appbar__sound { width: 44px; height: 44px; }
.appbar__sound svg { width: 20px; height: 20px; }

.shell__content:focus { outline: none; }

/* The skip link: off-screen until it has focus, then the first thing on the page. */
.skiplink {
  position: fixed;
  top: 8px;
  left: 8px;
  z-index: 100;
  padding: 12px 16px;
  border-radius: var(--radius);
  background: var(--ink-1);
  color: var(--bg-0);
  font-weight: 720;
  font-size: 14px;
  transform: translateY(-160%);
}
.skiplink:focus { transform: none; }

/* --- the avatar menu ------------------------------------------------------------------ */
.menuwrap { position: relative; }
button.avatar { appearance: none; padding: 0; border: 0; font-family: inherit; cursor: pointer; }
button.avatar[aria-expanded='true'] { box-shadow: inset 0 0 0 1.5px var(--gold-2); }

.navmenu {
  position: absolute;
  top: calc(100% + 10px);
  right: -6px;
  z-index: 50;
  width: min(300px, calc(100vw - 24px));
  max-height: calc(100svh - var(--appbar-h) - 24px);
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--line-2);
  border-radius: var(--radius);
  background: var(--bg-3);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.55);
}
.avatar__dot { position: absolute; top: -1px; right: -1px; width: 9px; height: 9px; border-radius: 50%; background: var(--gold-2); box-shadow: 0 0 0 2px var(--bg-0); }
.navmenu__count { margin-left: 8px; font-style: normal; }
.navmenu__who { display: grid; gap: 1px; margin: 0; padding: 10px 12px 12px; border-bottom: 1px solid var(--line-1); }
.navmenu__who b { font-size: 15px; font-weight: 720; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.navmenu__who span { font-size: 12.5px; }
.navmenu ul { list-style: none; margin: 0; padding: 4px 0; }
.navmenu a {
  display: grid;
  min-height: 48px;
  align-content: center;
  padding: 6px 12px;
  border-radius: 2px;
  color: var(--ink-1);
  font-size: 14.5px;
  font-weight: 620;
}
.navmenu a small { font-size: 12px; font-weight: 500; }
.navmenu a.router-link-active { background: var(--bg-4); }
.navmenu a:hover, .navmenu a:focus-visible { background: var(--bg-4); }
.navmenu__out {
  appearance: none;
  width: 100%;
  min-height: 48px;
  margin-top: 2px;
  padding: 0 12px;
  border: 0;
  border-top: 1px solid var(--line-1);
  background: transparent;
  color: var(--ink-2);
  font: inherit;
  font-size: 14px;
  font-weight: 620;
  text-align: left;
  cursor: pointer;
}
.navmenu__out:hover { color: var(--ink-1); }

.menu-enter-active { transition: opacity 0.16s var(--ease-out), transform 0.16s var(--ease-out); }
.menu-leave-active { transition: opacity 0.12s ease; }
.menu-enter-from { opacity: 0; transform: translateY(-4px); }
.menu-leave-to { opacity: 0; }

@media (min-width: 1024px) {
  .gifttoast { left: auto; right: 24px; bottom: 24px; }
}

.gift-enter-active { transition: opacity 0.24s var(--ease-out), transform 0.24s var(--ease-out); }
.gift-leave-active { transition: opacity 0.18s ease, transform 0.18s ease; }
.gift-enter-from, .gift-leave-to { opacity: 0; transform: translateY(10px); }

@media (prefers-reduced-motion: reduce) {
  .gift-enter-active, .gift-leave-active { transition: opacity 0.15s linear; }
  .gift-enter-from, .gift-leave-to { transform: none; }
  .menu-enter-active, .menu-leave-active { transition: none; }
}
</style>
