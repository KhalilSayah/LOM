<script setup lang="ts">
/**
 * Settings: the account and the device, in that order.
 *
 * Names save through /api/profile/name (profiles are not writable from the client). The
 * password changes through Supabase directly, after the current one has been checked, so a
 * phone left unlocked on a table cannot be used to lock its owner out. Sound and motion are
 * per-device preferences and live in localStorage.
 *
 * Deleting the account asks for the handle to be typed: an action that cannot be undone
 * should not be one tap away from "Sign out".
 */
const supabase = useSupabaseClient();
const user = useSupabaseUser();
const signOut = useSignOut();

const profile = ref<any>(null);
const loading = ref(true);
const loadError = ref('');

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    profile.value = (await $fetch<{ profile: any }>('/api/profile/me')).profile;
  } catch (e: any) {
    loadError.value = e?.data?.statusMessage || 'Your settings could not be loaded. Try again.';
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function onNameSaved(p: any) {
  if (p) profile.value = p;
}

// --- password --------------------------------------------------------------------------

const current = ref('');
const fresh = ref('');
const showPw = ref(false);
const pwBusy = ref(false);
const pwError = ref('');
const pwDone = ref(false);

async function changePassword() {
  pwError.value = '';
  pwDone.value = false;
  const email = (user.value as any)?.email as string | undefined;
  if (!current.value) { pwError.value = 'Enter your current password.'; return; }
  if (fresh.value.length < 8) { pwError.value = 'Use at least 8 characters for the new one.'; return; }
  if (new TextEncoder().encode(fresh.value).length > 72) { pwError.value = 'That password is too long. 72 characters at most.'; return; }
  if (fresh.value === current.value) { pwError.value = 'The new password is the same as the old one.'; return; }
  if (!email) { pwError.value = 'Sign in again, then try this.'; return; }

  pwBusy.value = true;
  try {
    const check = await supabase.auth.signInWithPassword({ email, password: current.value });
    if (check.error) {
      pwError.value = /invalid login/i.test(check.error.message) ? 'Your current password is not right.' : 'Could not check your current password. Try again.';
      return;
    }
    const { error } = await supabase.auth.updateUser({ password: fresh.value });
    if (error) {
      pwError.value = /weak|at least/i.test(error.message) ? 'Pick a stronger password.' : 'Your password could not be changed just now. Try again.';
      return;
    }
    current.value = '';
    fresh.value = '';
    pwDone.value = true;
    playSound('success');
  } catch {
    pwError.value = 'Could not reach the server. Check your connection.';
  } finally {
    pwBusy.value = false;
  }
}

// --- sound and motion ------------------------------------------------------------------

const { enabled: soundOn, volume, setEnabled, setVolume } = useSound();
function onVolume(e: Event) { setVolume(Number((e.target as HTMLInputElement).value)); }

const MOTION_KEY = 'lom-motion';
const reduceMotion = ref(false);
onMounted(() => {
  try { reduceMotion.value = window.localStorage.getItem(MOTION_KEY) === 'reduce'; } catch { /* */ }
});
function setReduceMotion(on: boolean) {
  reduceMotion.value = on;
  try {
    if (on) window.localStorage.setItem(MOTION_KEY, 'reduce');
    else window.localStorage.removeItem(MOTION_KEY);
  } catch { /* private mode: applies to this visit only */ }
  if (on) document.documentElement.dataset.motion = 'reduce';
  else delete document.documentElement.dataset.motion;
}

// --- leaving ---------------------------------------------------------------------------

const leaving = ref(false);
async function leave() {
  leaving.value = true;
  await signOut();
}

const deleteOpen = ref(false);
const typed = ref('');
const deleting = ref(false);
const deleteError = ref('');
const canDelete = computed(() => !!profile.value && typed.value.trim().replace(/^@/, '').toLowerCase() === profile.value.handle);

async function deleteAccount() {
  if (!canDelete.value || deleting.value) return;
  deleting.value = true;
  deleteError.value = '';
  try {
    await $fetch('/api/profile/delete', { method: 'POST', body: { confirm: typed.value } });
    try { await supabase.auth.signOut({ scope: 'local' }); } catch { /* the user is gone anyway */ }
    resetApp('/');
  } catch (e: any) {
    deleteError.value = e?.data?.statusMessage || 'Your account could not be deleted just now. Try again.';
    deleting.value = false;
  }
}

useHead({ title: 'Settings — LOM' });
</script>

<template>
  <main class="page settings">
    <header class="topbar">
      <NuxtLink class="backlink" to="/profile" data-sound="back"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>Profile</NuxtLink>
      <span class="topbar__meta">{{ user?.email }}</span>
    </header>
    <h1 class="settings__title">Settings</h1>

    <div v-if="loadError" class="notice notice--bad settings__error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn--ghost btn--sm" type="button" @click="load">Try again</button>
    </div>

    <section id="name" class="block" aria-labelledby="s-name">
      <h2 id="s-name" class="sect">Your name</h2>
      <div v-if="loading" class="skeleton settings__skel" aria-busy="true" />
      <div v-else-if="profile" class="panel">
        <p v-if="!profile.handleChosen" class="muted settings__hint">
          You are playing as <b>@{{ profile.handle }}</b>, a name we picked. Choose your own.
        </p>
        <NameForm
          id-prefix="settings-name"
          :handle="profile.handle"
          :display-name="profile.displayName"
          :team-name="profile.teamName"
          submit-label="Save name"
          @saved="onNameSaved"
        />
      </div>
    </section>

    <section class="block" aria-labelledby="s-pw">
      <h2 id="s-pw" class="sect">Password</h2>
      <form class="panel settings__form" novalidate @submit.prevent="changePassword">
        <input class="sr-only" type="email" autocomplete="username" :value="user?.email" tabindex="-1" aria-hidden="true" readonly>
        <div class="field">
          <label for="pw-current">Current password</label>
          <input id="pw-current" v-model="current" :type="showPw ? 'text' : 'password'" autocomplete="current-password" required>
        </div>
        <div class="field">
          <label for="pw-new">New password</label>
          <input id="pw-new" v-model="fresh" :type="showPw ? 'text' : 'password'" autocomplete="new-password" placeholder="At least 8 characters" minlength="8" required>
        </div>
        <label class="settings__check">
          <input v-model="showPw" type="checkbox"> Show passwords
        </label>
        <div role="alert" aria-live="assertive"><p v-if="pwError" class="notice notice--bad">{{ pwError }}</p></div>
        <p v-if="pwDone" class="settings__ok" role="status">Password changed.</p>
        <button class="btn btn--ghost" type="submit" :disabled="pwBusy" data-sound="none">
          {{ pwBusy ? 'Changing' : 'Change password' }}
        </button>
      </form>
    </section>

    <section class="block" aria-labelledby="s-device">
      <h2 id="s-device" class="sect">On this device</h2>
      <div class="panel rows">
        <div class="row">
          <span id="sound-label"><b>Game sounds</b><small class="faint">Reveals, the draft, the match</small></span>
          <ClientOnly>
            <button class="switch" type="button" role="switch" aria-labelledby="sound-label" :aria-checked="soundOn" data-sound="none" @click="setEnabled(!soundOn)">
              <span class="switch__knob" />
            </button>
          </ClientOnly>
        </div>
        <label class="row row--vol" :class="{ 'is-off': !soundOn }">
          <span><b>Volume</b></span>
          <input type="range" min="0" max="1" step="0.05" :value="volume" :disabled="!soundOn" @input="onVolume" @change="playSound('coin')">
        </label>
        <div class="row">
          <span id="motion-label"><b>Reduce motion</b><small class="faint">Calmer reveals and transitions, whatever the device is set to</small></span>
          <ClientOnly>
            <button class="switch" type="button" role="switch" aria-labelledby="motion-label" :aria-checked="reduceMotion" @click="setReduceMotion(!reduceMotion)">
              <span class="switch__knob" />
            </button>
          </ClientOnly>
        </div>
      </div>
    </section>

    <section class="block" aria-labelledby="s-account">
      <h2 id="s-account" class="sect">Account</h2>
      <button class="btn btn--ghost btn--block" type="button" data-sound="back" :disabled="leaving" @click="leave">
        {{ leaving ? 'Signing out' : 'Sign out' }}
      </button>

      <div class="danger">
        <button
          v-if="!deleteOpen" class="btn btn--quiet btn--block" type="button"
          aria-controls="delete-panel" :aria-expanded="deleteOpen" @click="deleteOpen = true"
        >Delete account</button>

        <form v-else id="delete-panel" class="danger__panel" novalidate @submit.prevent="deleteAccount">
          <h3>Delete your account</h3>
          <p class="muted">
            Your cards, team, credits, sponsors, duels and league seats go with it, and it cannot
            be undone. If you host a league that others are in, hosting passes to the next manager.
          </p>
          <div class="field">
            <label for="delete-confirm">Type <b>{{ profile?.handle }}</b> to confirm</label>
            <input id="delete-confirm" v-model="typed" type="text" autocomplete="off" autocapitalize="none" spellcheck="false">
          </div>
          <div role="alert" aria-live="assertive"><p v-if="deleteError" class="notice notice--bad">{{ deleteError }}</p></div>
          <div class="danger__actions">
            <button class="btn btn--quiet" type="button" @click="deleteOpen = false; typed = ''; deleteError = ''">Keep my account</button>
            <button class="btn btn--danger" type="submit" :disabled="!canDelete || deleting" data-sound="none">
              {{ deleting ? 'Deleting' : 'Delete for good' }}
            </button>
          </div>
        </form>
      </div>
    </section>

    <p class="faint settings__foot">
      <NuxtLink to="/how-to-play">How to play</NuxtLink>
    </p>
  </main>
</template>

<style scoped>
.backlink { display: inline-flex; align-items: center; gap: 4px; min-height: 44px; margin-left: -6px; padding-right: 8px; font-size: 13.5px; font-weight: 600; color: var(--ink-2); }
.backlink svg { width: 20px; height: 20px; }
.backlink:hover { color: var(--ink-1); }
.topbar__meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }
.settings__title { font-size: 30px; margin: 0 0 4px; }
.settings__error { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; }
.settings__skel { height: 260px; }
.settings__hint { margin: 0 0 14px; font-size: 13.5px; }
.settings__form { display: grid; gap: 14px; }
.settings__form .btn { justify-self: start; }
.settings__check { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; font-size: 13.5px; color: var(--ink-2); cursor: pointer; }
.settings__check input { width: 18px; height: 18px; accent-color: var(--gold-2); }
.settings__ok { margin: 0; font-size: 13px; color: var(--teal-1); }

.sect { margin: 0 0 12px; font-stretch: 92%; font-weight: 720; font-size: 17px; }

.rows { padding: 4px 16px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 64px; }
.row + .row { border-top: 1px solid var(--line-1); }
.row b { display: block; font-size: 14.5px; font-weight: 650; }
.row small { display: block; font-size: 12.5px; }
.row--vol input { width: min(220px, 50%); min-height: 44px; accent-color: var(--gold-2); }
.row--vol.is-off { opacity: 0.5; }

/* 44px tall hit area around a 28px track. */
.switch { position: relative; flex: none; width: 52px; height: 44px; padding: 0; border: 0; background: transparent; cursor: pointer; }
.switch::before { content: ''; position: absolute; left: 2px; right: 2px; top: 8px; height: 28px; border-radius: 14px; background: var(--bg-4); transition: background 0.15s ease; }
.switch[aria-checked='true']::before { background: var(--teal-2); }
.switch__knob { position: absolute; top: 11px; left: 5px; width: 22px; height: 22px; border-radius: 50%; background: var(--ink-1); transition: transform 0.18s var(--ease-out); }
.switch[aria-checked='true'] .switch__knob { transform: translateX(20px); }

.danger { margin-top: 12px; }
.danger__panel { display: grid; gap: 14px; padding: 16px; border: 1px solid rgba(240, 80, 95, 0.4); border-radius: var(--radius); background: rgba(240, 80, 95, 0.05); }
.danger__panel h3 { font-size: 19px; }
.danger__panel p { margin: 0; font-size: 13.5px; line-height: 1.55; }
.danger__actions { display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; }

.settings__foot { margin: 28px 0 0; text-align: center; font-size: 13px; }
@media (prefers-reduced-motion: reduce) { .switch::before, .switch__knob { transition: none; } }
</style>
