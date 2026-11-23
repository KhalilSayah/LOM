<script setup lang="ts">
/**
 * Where a password-reset email lands.
 *
 * The door's "Forgot password?" asks Supabase to mail a link with `redirectTo` pointing
 * here. Supabase verifies the token on its side and redirects with a one-time code (or,
 * in the older flow, a token in the hash); the browser client exchanges it for a short
 * recovery session on load, which is what allows `updateUser({ password })` below. So
 * this page waits for that session, then asks for the new password once.
 *
 * Open to signed-out visitors (see middleware/auth.global.ts), because when the link is
 * opened there is no session yet. A signed-in manager who comes here directly can use it
 * to change their password too, though Settings is the usual way.
 */
const supabase = useSupabaseClient();
const user = useSupabaseUser();
const route = useRoute();
const focus = useFocusMode();

const state = ref<'waiting' | 'ready' | 'done' | 'failed'>('waiting');
const failure = ref('');
const password = ref('');
const confirm = ref('');
const show = ref(false);
const busy = ref(false);
const error = ref('');

function urlError(): string | null {
  const q = route.query;
  const hash = new URLSearchParams((route.hash || '').replace(/^#/, ''));
  const code = (q.error_code || q.error || hash.get('error_code') || hash.get('error')) as string | null;
  if (!code) return null;
  return /expired/i.test(String(code) + String(q.error_description || hash.get('error_description') || ''))
    ? 'That reset link has expired. Links work for a limited time; ask for a new one.'
    : 'That reset link could not be used. It may already have been used. Ask for a new one.';
}

let giveUp: ReturnType<typeof setTimeout> | undefined;

watch(user, (u) => {
  if (u && state.value === 'waiting') state.value = 'ready';
}, { immediate: true });

onMounted(() => {
  focus.value = true;
  const bad = urlError();
  if (bad) { failure.value = bad; state.value = 'failed'; return; }
  giveUp = setTimeout(() => {
    if (state.value !== 'waiting') return;
    failure.value = 'This link did not open a reset. It may already have been used, or been '
      + 'opened in a different browser from the one that asked for it. Ask for a new one.';
    state.value = 'failed';
  }, 8000);
});
onBeforeUnmount(() => { clearTimeout(giveUp); focus.value = false; });

async function save() {
  error.value = '';
  if (password.value.length < 8) { error.value = 'Use at least 8 characters.'; return; }
  if (new TextEncoder().encode(password.value).length > 72) { error.value = 'That password is too long. 72 characters at most.'; return; }
  if (password.value !== confirm.value) { error.value = 'The two passwords do not match.'; return; }
  busy.value = true;
  try {
    const { error: err } = await supabase.auth.updateUser({ password: password.value });
    if (err) throw err;
    password.value = '';
    confirm.value = '';
    state.value = 'done';
    playSound('success');
  } catch (e: any) {
    const raw = String(e?.message || '');
    error.value = /different from the old|same.*password/i.test(raw)
      ? 'That is your current password. Pick a new one.'
      : /weak|at least/i.test(raw)
        ? 'Pick a stronger password, at least 8 characters.'
        : /session|expired|jwt/i.test(raw)
          ? 'The reset session has run out. Ask for a new link.'
          : 'Your password could not be changed just now. Try again.';
    playSound('error');
  } finally {
    busy.value = false;
  }
}

useHead({ title: 'Reset your password — LOM' });
</script>

<template>
  <main class="page reset">
    <span class="logo reset__logo">
      <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M14 2l12 12-12 12L2 14z" fill="none" stroke="#d8b064" stroke-width="1.6" /><path d="M14 7.5L20.5 14 14 20.5 7.5 14z" fill="#d8b064" /></svg>
      <b>LOM</b>
    </span>

    <template v-if="state === 'waiting'">
      <span class="reset__spinner" aria-hidden="true" />
      <h1>Opening your reset link</h1>
      <p class="muted reset__line" role="status" aria-live="polite">One moment.</p>
    </template>

    <template v-else-if="state === 'failed'">
      <span class="reset__mark" aria-hidden="true" />
      <h1>Link not usable</h1>
      <p class="muted reset__line" role="alert">{{ failure }}</p>
      <NuxtLink class="btn" :to="{ path: '/', query: { mode: 'forgot' } }">Send a new link</NuxtLink>
    </template>

    <template v-else-if="state === 'done'">
      <span class="reset__mark" aria-hidden="true" />
      <h1>Password changed</h1>
      <p class="muted reset__line" role="status">You are signed in with your new password.</p>
      <NuxtLink class="btn" to="/pack">Continue</NuxtLink>
    </template>

    <form v-else class="reset__form" novalidate @submit.prevent="save">
      <h1>Set a new password</h1>
      <div class="field">
        <label for="new-password">New password</label>
        <div class="pw">
          <input
            id="new-password" v-model="password" :type="show ? 'text' : 'password'"
            autocomplete="new-password" placeholder="At least 8 characters" minlength="8" required
          >
          <button
            class="pw__toggle" type="button" data-sound="none" aria-controls="new-password confirm-password"
            :aria-pressed="show" :aria-label="show ? 'Hide passwords' : 'Show passwords'" @click="show = !show"
          >
            <svg v-if="!show" class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></svg>
            <svg v-else class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4l16 16M10 6a9.6 9.6 0 0 1 2-.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.6M6.5 7.6A16.7 16.7 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4-.9M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
          </button>
        </div>
      </div>
      <div class="field">
        <label for="confirm-password">Type it again</label>
        <input id="confirm-password" v-model="confirm" :type="show ? 'text' : 'password'" autocomplete="new-password" required>
      </div>
      <div role="alert" aria-live="assertive"><p v-if="error" class="notice notice--bad">{{ error }}</p></div>
      <button class="btn btn--lg btn--block" type="submit" :disabled="busy" data-sound="none">
        {{ busy ? 'Saving' : 'Save new password' }}
      </button>
    </form>
  </main>
</template>

<style scoped>
.reset {
  min-height: 100svh;
  max-width: 420px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  text-align: center;
}
.reset__logo { margin-bottom: 18px; }
.reset h1 { font-size: clamp(26px, 6vw, 34px); }
.reset__line { margin: 0; max-width: 40ch; font-size: 14.5px; }
.reset .btn { margin-top: 6px; }
.reset__form { display: grid; gap: 14px; width: 100%; text-align: left; }
.reset__form h1 { margin-bottom: 6px; }

.reset__spinner {
  width: 34px; height: 34px; border-radius: 50%;
  border: 2px solid var(--line-2); border-top-color: var(--gold-2);
  animation: reset-spin 0.9s linear infinite;
}
.reset__mark { width: 14px; height: 14px; margin: 10px; background: var(--gold-2); transform: rotate(45deg); }
@keyframes reset-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .reset__spinner { animation: none; } }

.pw { position: relative; }
.pw input { padding-right: 52px; }
.pw__toggle {
  position: absolute; top: 2px; right: 2px;
  display: grid; place-items: center; width: 44px; height: 44px;
  border: 0; border-radius: 2px; background: transparent; color: var(--ink-3); cursor: pointer;
}
.pw__toggle svg { width: 20px; height: 20px; }
.pw__toggle:hover, .pw__toggle[aria-pressed='true'] { color: var(--ink-1); }
</style>
