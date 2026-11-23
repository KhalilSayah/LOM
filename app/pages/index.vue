<script setup lang="ts">
const supabase = useSupabaseClient();
const user = useSupabaseUser();
const route = useRoute();
const focus = useFocusMode();

/**
 * Supabase's auth errors are written for whoever wired the project up, not for whoever is
 * trying to sign in. Each one it can send back is mapped to something a player can act on;
 * anything unrecognised becomes a plain "try again" and the raw text goes to the console.
 * Messages from our own routes (sign-up) are already written for players and pass through.
 */
const MESSAGES: Array<[RegExp, string]> = [
  [/rate limit|over_email_send_rate_limit|too many/i,
    'Too many emails have gone out in a short time. Wait a few minutes and try again.'],
  [/for security purposes|only request this after/i,
    'A link was sent a moment ago. Give it a minute before asking for another.'],
  [/user already registered|already been registered/i,
    'That email already has an account. Sign in instead.'],
  [/invalid login credentials/i, 'Wrong email or password.'],
  [/email not confirmed/i, 'This account still needs confirming. We can send the confirmation email again.'],
  [/password should be at least|weak password/i, 'Use a longer password, at least 8 characters.'],
  [/failed to fetch|network|load failed/i, 'Could not reach the server. Check your connection.'],
];

function readable(raw: string, fromUs: boolean): string {
  for (const [pattern, text] of MESSAGES) if (pattern.test(raw)) return text;
  if (fromUs && raw) return raw;
  console.warn('[door]', raw);
  return 'That did not work. Try again in a moment.';
}

/**
 * Where the door leads. Normally the pack; an invite link that was followed while
 * signed out leaves its own destination in `?next=`, and that is where a manager who
 * has just signed up to join a league has to end up.
 */
const next = computed(() => safeNext(route.query.next));

const inviteCode = computed(() => {
  const m = /^\/join\/([^/?#]+)/.exec(next.value);
  return m ? decodeURIComponent(m[1]!) : null;
});
const shareCode = computed(() => {
  const m = /^\/m\/([^/?#]+)/.exec(next.value);
  return m ? decodeURIComponent(m[1]!) : null;
});

/**
 * Who sent you. Fetched during SSR, so the banner is there on first paint and — because
 * every link-preview bot is signed out and lands here — so the preview card a group chat
 * draws for an invite says whose league it is rather than just "LOM".
 */
const { data: invite } = await useAsyncData(
  'door-invite',
  async () => {
    if (!inviteCode.value) return null;
    try {
      const res = await $fetch<any>('/api/auth/invite', { query: { code: inviteCode.value } });
      return res?.found ? res as { league: string; host: string; memberCount: number; maxMembers: number; open: boolean } : null;
    } catch { return null; }
  },
  { watch: [inviteCode] },
);
const { data: sharer } = await useAsyncData(
  'door-sharer',
  async () => {
    if (!shareCode.value) return null;
    try {
      const res = await $fetch<any>('/api/auth/manager', { query: { code: shareCode.value } });
      return res?.found ? res as { name: string } : null;
    } catch { return null; }
  },
  { watch: [shareCode] },
);

type Mode = 'in' | 'up' | 'forgot' | 'sent' | 'name';

const asked = route.query.mode;
const mode = ref<Mode>(asked === 'in' || asked === 'up' || asked === 'forgot' ? asked : inviteCode.value ? 'up' : 'in');
const email = ref('');
const password = ref('');
const showPassword = ref(false);
const busy = ref(false);
const error = ref('');
const needsConfirm = ref(false);
const info = ref('');

/** The landing page is one screen. The account form slides over it when it is asked for. */
const accountOpen = ref(asked === 'in' || asked === 'up' || asked === 'forgot');
function openAccount(m: 'in' | 'up') {
  setMode(m);
  accountOpen.value = true;
}

/** Set while the name step is about to show, so the redirect below does not fire first. */
const holding = ref(false);

watchEffect(() => {
  if (user.value && !holding.value && mode.value !== 'name') navigateTo(next.value);
});

// The name step is a full-screen moment: no tab bar under it to wander off through.
watch(mode, (m) => {
  focus.value = m === 'name';
  if (m === 'name') accountOpen.value = true;
});
onBeforeUnmount(() => { focus.value = false; });

function setMode(m: Mode) {
  mode.value = m;
  error.value = '';
  info.value = '';
  needsConfirm.value = false;
}

// --- the segmented control, as a proper tab list --------------------------------------

const TABS: Array<{ id: 'in' | 'up'; label: string }> = [
  { id: 'in', label: 'Sign in' },
  { id: 'up', label: 'Create account' },
];
const tabRefs: HTMLButtonElement[] = [];
function setTabRef(el: unknown, i: number) {
  if (el) tabRefs[i] = el as HTMLButtonElement;
}
const activeTab = computed(() => (mode.value === 'up' ? 'up' : 'in'));

function onTabKey(e: KeyboardEvent, i: number) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  const n = TABS.length;
  const j = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n;
  setMode(TABS[j]!.id);
  tabRefs[j]?.focus();
}

// --- sign in / create account ----------------------------------------------------------

async function submit() {
  error.value = '';
  needsConfirm.value = false;

  const address = email.value.trim();
  if (!address || password.value.length < 8) {
    error.value = 'Enter your email and a password of at least 8 characters.';
    return;
  }

  busy.value = true;
  try {
    if (mode.value === 'up') {
      holding.value = true;
      // Created server-side with the admin API so the account comes out already confirmed:
      // no mail and no dependency on a dashboard toggle this app cannot reach. Then sign in
      // normally with the password we already have.
      try {
        await $fetch('/api/auth/signup', { method: 'POST', body: { email: address, password: password.value } });
      } catch (e: any) {
        holding.value = false;
        const raw = e?.data?.statusMessage || e?.statusMessage || '';
        error.value = raw || 'We could not create your account just now. Try again in a minute.';
        if (e?.statusCode === 409 || e?.status === 409) mode.value = 'in';
        return;
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({ email: address, password: password.value });
      if (signInError) { holding.value = false; throw signInError; }
      password.value = '';
      mode.value = 'name';
      holding.value = false;
      return;
    }

    const { error: err } = await supabase.auth.signInWithPassword({ email: address, password: password.value });
    if (err) throw err;
    await navigateTo(next.value);
  } catch (e: any) {
    const raw = e?.message || '';
    error.value = readable(raw, false);
    if (/email not confirmed/i.test(raw)) needsConfirm.value = true;
  } finally {
    busy.value = false;
  }
}

// --- emails: reset link, confirmation resend ------------------------------------------

const cooldown = ref(0);
let cooldownTimer: ReturnType<typeof setInterval> | undefined;
function startCooldown(seconds = 60) {
  cooldown.value = seconds;
  clearInterval(cooldownTimer);
  cooldownTimer = setInterval(() => {
    cooldown.value -= 1;
    if (cooldown.value <= 0) clearInterval(cooldownTimer);
  }, 1000);
}
onBeforeUnmount(() => clearInterval(cooldownTimer));

const origin = () => window.location.origin;

async function sendReset() {
  error.value = '';
  const address = email.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(address)) {
    error.value = 'Enter the email you signed up with.';
    return;
  }
  if (cooldown.value > 0) return;
  busy.value = true;
  try {
    const { error: err } = await supabase.auth.resetPasswordForEmail(address, { redirectTo: `${origin()}/reset` });
    if (err) throw err;
    mode.value = 'sent';
    startCooldown();
  } catch (e: any) {
    error.value = readable(e?.message || '', false);
  } finally {
    busy.value = false;
  }
}

async function resendConfirm() {
  if (cooldown.value > 0) return;
  busy.value = true;
  try {
    const { error: err } = await supabase.auth.resend({
      type: 'signup',
      email: email.value.trim(),
      options: { emailRedirectTo: `${origin()}/confirm${route.query.next ? `?next=${encodeURIComponent(next.value)}` : ''}` },
    });
    if (err) throw err;
    needsConfirm.value = false;
    error.value = '';
    info.value = `Sent. Open the link in the email to ${email.value.trim()} on this device.`;
    startCooldown();
  } catch (e: any) {
    error.value = readable(e?.message || '', false);
  } finally {
    busy.value = false;
  }
}

// --- the name step ---------------------------------------------------------------------

const { data: me } = useLazyAsyncData('door-me', async () => {
  if (mode.value !== 'name') return null;
  try { return (await $fetch<any>('/api/profile/me')).profile; } catch { return null; }
}, { watch: [mode], server: false });

function nameDone() {
  navigateTo(next.value);
}

// --- what the page says about itself ---------------------------------------------------

const pageTitle = computed(() => {
  if (invite.value) return `${invite.value.host} invited you to ${invite.value.league}`;
  if (sharer.value) return `${sharer.value.name}'s cards on LOM`;
  return 'LOM — League of Managers';
});
const pageDescription = computed(() => {
  if (invite.value) {
    return `A private LOM league, ${invite.value.memberCount} of ${invite.value.maxMembers} managers in. `
      + 'Collect real pro player-seasons, draft against friends, play a season together.';
  }
  if (sharer.value) return `See the pro League of Legends player cards ${sharer.value.name} has collected.`;
  return 'Collect real player-seasons from pro League of Legends. One pack a day, a five to field, friends to draft against.';
});

useSeoMeta({
  title: () => (invite.value || sharer.value ? `${pageTitle.value} — LOM` : pageTitle.value),
  description: pageDescription,
  ogTitle: pageTitle,
  ogDescription: pageDescription,
  twitterTitle: pageTitle,
  twitterDescription: pageDescription,
});
</script>


<template>
  <main class="door">
    <h1 class="brand">
      <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M14 2l12 12-12 12L2 14z" fill="none" stroke="#d8b064" stroke-width="1.6" /><path d="M14 7.5L20.5 14 14 20.5 7.5 14z" fill="#d8b064" /></svg>
      <b>LOM</b>
      <small>League of Managers</small>
    </h1>

    <button class="door__pack" type="button" data-sound="select" aria-label="Play and open your first pack" @click="openAccount('up')">
      <span class="door__packart"><ClientOnly><PackCover kind="DAILY" /></ClientOnly></span>
    </button>

    <p v-if="invite" class="door__invite">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v4.5a5 5 0 0 1-10 0zM7 6H4.5a2.5 2.5 0 0 0 2.6 3.4M17 6h2.5a2.5 2.5 0 0 1-2.6 3.4M12 13.5V17M8.5 20h7l-1-3h-5z" /></svg>
      <span>
        <b>{{ invite.host }}</b> invited you to <b>{{ invite.league }}</b>
        <small class="faint">{{ invite.memberCount }} of {{ invite.maxMembers }} managers so far<template v-if="!invite.open"> · the invite has closed</template></small>
      </span>
    </p>
    <p v-else-if="sharer" class="door__invite">
      <span><b>{{ sharer.name }}</b> shared their collection with you.<small class="faint">Sign in to see their cards.</small></span>
    </p>
    <p v-else class="door__line">Collect the players who actually played.</p>

    <div class="door__cta">
      <button class="btn btn--lg btn--block" type="button" data-sound="select" @click="openAccount('up')">Play</button>
      <button class="btn btn--ghost btn--block" type="button" @click="openAccount('in')">I have an account</button>
      <p class="door__foot">
        A private, non-commercial fan project. Not affiliated with or endorsed by Riot Games.
        Champion art from Riot's Data Dragon.
      </p>
    </div>

    <section class="acct" :class="{ 'is-open': accountOpen }" :aria-hidden="!accountOpen" aria-label="Your account">
      <button v-if="mode !== 'name'" class="icon-btn acct__close" type="button" data-sound="back" aria-label="Close" @click="accountOpen = false">
        <svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>

      <!-- The step after sign-up: a name you chose, not one read off your email. -->
      <template v-if="mode === 'name'">
        <header class="door__head">
          <p class="label door__step">Step 2 of 2</p>
          <h1>Choose your name.</h1>
          <p class="door__lede">
            It is what rivals see across the draft and what your league table says. You can
            change it later in Settings.
          </p>
        </header>
        <NameForm
          id-prefix="door-name"
          :handle="me?.handleChosen ? me.handle : ''"
          :display-name="me?.handleChosen ? me.displayName : ''"
          :team-name="me?.teamName ?? ''"
          submit-label="Save and continue"
          @saved="nameDone"
        >
          <template #secondary>
            <button class="btn btn--quiet btn--block" type="button" @click="nameDone">Skip for now</button>
          </template>
        </NameForm>
      </template>

      <template v-else>
        <header v-if="mode === 'up' || mode === 'in'" class="door__head">
          <h2>{{ mode === 'up' ? 'Create your account' : 'Welcome back' }}</h2>
        </header>

        <!-- Forgotten password: one field, one link. -->
        <form v-if="mode === 'forgot' || mode === 'sent'" class="door__form" novalidate @submit.prevent="sendReset">
          <h2 class="door__formhead">Reset your password</h2>
          <template v-if="mode === 'forgot'">
            <p class="muted door__small">We will email you a link to set a new one.</p>
            <div class="field">
              <label for="reset-email">Email</label>
              <input id="reset-email" v-model="email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" required>
            </div>
          </template>
          <p v-else class="notice notice--live" role="status">
            If <strong>{{ email.trim() }}</strong> has an account, a reset link is on its way. Open it
            on this device. Nothing after a few minutes? Check spam, or send it again.
          </p>

          <div role="alert" aria-live="assertive"><p v-if="error" class="notice notice--bad">{{ error }}</p></div>

          <button class="btn btn--lg btn--block" type="submit" :disabled="busy || cooldown > 0">
            <template v-if="busy">One moment</template>
            <template v-else-if="mode === 'sent'">{{ cooldown > 0 ? `Send again in ${cooldown}s` : 'Send again' }}</template>
            <template v-else>Send reset link</template>
          </button>
          <button class="btn btn--quiet btn--block" type="button" data-sound="back" @click="setMode('in')">Back to sign in</button>
        </form>

        <form v-else class="door__form" novalidate @submit.prevent="submit">
          <div class="seg door__tabs" role="tablist" aria-label="Account">
            <button
              v-for="(t, i) in TABS" :id="`door-tab-${t.id}`" :key="t.id"
              :ref="(el) => setTabRef(el, i)"
              type="button" role="tab"
              :aria-selected="activeTab === t.id" :tabindex="activeTab === t.id ? 0 : -1"
              aria-controls="door-panel"
              @click="setMode(t.id)" @keydown="onTabKey($event, i)"
            >{{ t.label }}</button>
          </div>

          <div id="door-panel" class="door__fields" role="tabpanel" :aria-labelledby="`door-tab-${activeTab}`">
            <div class="field">
              <label for="email">Email</label>
              <input id="email" v-model="email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" required>
            </div>

            <div class="field">
              <div class="door__labelrow">
                <label for="password">Password</label>
                <button v-if="mode === 'in'" class="door__link" type="button" @click="setMode('forgot')">Forgot password?</button>
              </div>
              <div class="pw">
                <input
                  id="password" v-model="password" :type="showPassword ? 'text' : 'password'"
                  :autocomplete="mode === 'up' ? 'new-password' : 'current-password'"
                  placeholder="At least 8 characters" required minlength="8"
                >
                <button
                  class="pw__toggle" type="button" data-sound="none"
                  :aria-pressed="showPassword" aria-controls="password"
                  :aria-label="showPassword ? 'Hide password' : 'Show password'"
                  @click="showPassword = !showPassword"
                >
                  <svg v-if="!showPassword" class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></svg>
                  <svg v-else class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4l16 16M10 6a9.6 9.6 0 0 1 2-.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.6M6.5 7.6A16.7 16.7 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4-.9M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
                </button>
              </div>
            </div>

            <div role="alert" aria-live="assertive">
              <p v-if="error" class="notice notice--bad">
                {{ error }}
                <button v-if="needsConfirm" class="door__link door__link--inline" type="button" :disabled="busy || cooldown > 0" @click="resendConfirm">
                  {{ cooldown > 0 ? `Send again in ${cooldown}s` : 'Send the confirmation email' }}
                </button>
              </p>
            </div>
            <p v-if="info" class="notice notice--live" role="status">{{ info }}</p>

            <button class="btn btn--lg btn--block" type="submit" :disabled="busy">
              {{ busy ? 'One moment' : mode === 'up' ? 'Create account' : 'Sign in' }}
            </button>
            <p v-if="mode === 'up'" class="faint door__small">Step 1 of 2. Next you choose the name other players see.</p>
          </div>
        </form>

        <p class="door__how">
          New here? <NuxtLink to="/how-to-play">How to play, in five steps</NuxtLink>
        </p>
      </template>

    </section>
  </main>
</template>

<style scoped>
/* One screen: the name, the pack, play. Nothing here scrolls. */
.door {
  position: relative;
  height: 100vh;
  height: 100dvh;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto auto;
  justify-items: center;
  gap: 14px;
  overflow: hidden;
  overflow: clip;
  padding: calc(20px + env(safe-area-inset-top, 0px)) max(20px, env(safe-area-inset-right, 0px)) calc(14px + env(safe-area-inset-bottom, 0px)) max(20px, env(safe-area-inset-left, 0px));
}
.brand { display: grid; justify-items: center; gap: 7px; margin: 0; }
.brand svg { width: 34px; height: 34px; }
.brand b { font-stretch: 125%; font-size: clamp(34px, 11vw, 48px); font-weight: 860; letter-spacing: 0.24em; text-indent: 0.24em; line-height: 1; color: var(--ink-1); }
.brand small { font-stretch: 118%; font-size: clamp(11px, 3.3vw, 14px); font-weight: 700; letter-spacing: 0.26em; text-indent: 0.26em; text-transform: uppercase; color: var(--gold-2); white-space: nowrap; }
.door__pack { position: relative; width: 100%; min-height: 0; padding: 0; border: 0; background: none; cursor: pointer; }
.door__packart { position: absolute; left: 50%; top: 50%; display: block; height: 100%; max-width: 100%; aspect-ratio: 580 / 850; transform: translate(-50%, -50%); }
.door__line { margin: 0; color: var(--ink-2); font-size: 14.5px; text-align: center; }
.door__cta { display: grid; gap: 9px; width: min(100%, 380px); }
.door__foot { margin: 0; font-size: 11px; line-height: 1.4; color: var(--ink-3); text-align: center; max-width: 44ch; justify-self: center; }

/* The invite: a gold-cornered card, the same mark the invite screen uses. */
.door__invite {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: min(100%, 380px);
  margin: 0;
  padding: 9px 12px;
  border: 1px solid rgba(216, 176, 100, 0.34);
  border-radius: var(--radius);
  background: rgba(216, 176, 100, 0.06);
  font-size: 14px;
  line-height: 1.35;
}
.door__invite .ico { flex: none; width: 24px; height: 24px; stroke: var(--gold-2); }
.door__invite b { color: var(--gold-1); font-weight: 720; }
.door__invite small { display: block; margin-top: 2px; font-size: 12.5px; }

/* The account form, over the landing page. It may scroll: a phone keyboard takes half the screen. */
.acct {
  position: absolute;
  z-index: 12;
  left: 0;
  right: 0;
  bottom: 0;
  display: grid;
  gap: 14px;
  max-width: 460px;
  max-height: 100%;
  margin-inline: auto;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 18px max(20px, env(safe-area-inset-right, 0px)) calc(18px + env(safe-area-inset-bottom, 0px)) max(20px, env(safe-area-inset-left, 0px));
  border: 1px solid var(--line-2);
  border-bottom: 0;
  border-radius: var(--radius) var(--radius) 0 0;
  background: var(--bg-2);
  box-shadow: 0 -18px 40px rgba(0, 0, 0, 0.55);
  transform: translateY(103%);
  visibility: hidden;
  transition: transform 0.28s var(--ease-sheet), visibility 0s linear 0.28s;
}
.acct.is-open { transform: none; visibility: visible; transition: transform 0.28s var(--ease-sheet); }
.acct__close { position: absolute; top: 8px; right: 8px; }
.acct__close svg { width: 19px; height: 19px; }
.door__head { padding-right: 44px; }
.door__head h1, .door__head h2 { font-size: 25px; line-height: 1; font-stretch: 78%; font-weight: 850; }
.door__lede { margin: 8px 0 0; color: var(--ink-2); font-size: 14px; line-height: 1.45; }
.door__step { margin: 0 0 8px; color: var(--gold-2); }
.door__form { display: grid; gap: 14px; }
.door__fields { display: grid; gap: 14px; }
.door__formhead { font-size: 22px; }
.door__small { margin: 0; font-size: 13px; line-height: 1.5; }
.door__how { margin: -4px 0 0; font-size: 13.5px; color: var(--ink-2); }
.door__how a { color: var(--ink-1); text-decoration: underline; text-decoration-color: var(--line-3); text-underline-offset: 3px; }

/* Tabs: same look as .seg, keyed on aria-selected because these are real tabs. */
.door__tabs button[aria-selected='true'] { background: var(--bg-3); color: var(--ink-1); box-shadow: inset 0 -2px 0 var(--gold-2); }

.door__labelrow { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.door__link {
  appearance: none;
  min-height: 44px;
  margin: -14px -8px -14px 0;
  padding: 0 8px;
  border: 0;
  background: none;
  color: var(--ink-2);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  text-decoration: underline;
  text-decoration-color: var(--line-3);
  text-underline-offset: 3px;
  cursor: pointer;
}
.door__link:hover { color: var(--ink-1); }
.door__link--inline { display: inline; min-height: 0; margin: 0; padding: 0; color: #ffd9dd; }

.pw { position: relative; }
.pw input { padding-right: 52px; }
.pw__toggle {
  position: absolute;
  top: 2px;
  right: 2px;
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: 2px;
  background: transparent;
  color: var(--ink-3);
  cursor: pointer;
}
.pw__toggle svg { width: 20px; height: 20px; }
.pw__toggle:hover, .pw__toggle[aria-pressed='true'] { color: var(--ink-1); }


@media (max-height: 640px) {
  .door { gap: 9px; padding-top: calc(14px + env(safe-area-inset-top, 0px)); }
  .brand svg, .door__line { display: none; }
  .door__cta .btn { min-height: 46px; }
}
@media (prefers-reduced-motion: reduce) { .acct { transition: none; } }
</style>
