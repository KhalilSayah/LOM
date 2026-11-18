<script setup lang="ts">
const supabase = useSupabaseClient();
const user = useSupabaseUser();

/**
 * Supabase's auth errors are written for whoever wired the project up, not for whoever is
 * trying to sign in. The rate-limit one is the sharpest: it means the project's built-in
 * SMTP is capped for the hour, which has nothing to do with the person reading it and is
 * fixed by turning email confirmation off.
 */
const MESSAGES: Array<[RegExp, string]> = [
  [/email rate limit exceeded|over_email_send_rate_limit/i,
    'Too many confirmation emails from this project in the last hour. Turn off '
    + 'email confirmation in Supabase (Authentication > Providers > Email), or wait an hour.'],
  [/user already registered|already been registered/i,
    'That email already has an account. Sign in instead.'],
  [/invalid login credentials/i, 'Wrong email or password.'],
  [/email not confirmed/i, 'This account still needs confirming. Check your inbox.'],
  [/password should be at least/i, 'Use a longer password — at least 8 characters.'],
  [/failed to fetch|network/i, 'Could not reach the server. Check your connection.'],
];

function readable(message: string): string {
  for (const [pattern, text] of MESSAGES) if (pattern.test(message)) return text;
  return message;
}

const mode = ref<'in' | 'up'>('in');
const email = ref('');
const password = ref('');
const busy = ref(false);
const error = ref('');
const check = ref(false);

watchEffect(() => {
  if (user.value) navigateTo('/pack');
});

async function submit() {
  error.value = '';
  check.value = false;

  if (!email.value.trim() || password.value.length < 8) {
    error.value = 'Enter your email and a password of at least 8 characters.';
    return;
  }

  busy.value = true;
  try {
    if (mode.value === 'up') {
      const { data, error: err } = await supabase.auth.signUp({
        email: email.value.trim(),
        password: password.value,
        options: {
          // Without this the confirmation link goes wherever Supabase's Site URL points,
          // which is localhost until someone remembers to change it. Sending the current
          // origin means a link opened from the deployed site comes back to the deployed
          // site, and one opened from a dev machine comes back there. Supabase still has
          // to allow the URL: Authentication > URL Configuration > Redirect URLs.
          emailRedirectTo: `${window.location.origin}/confirm`,
        },
      });
      if (err) throw err;

      // Signing up is meant to sign you in. LOM is a friends-only league, the built-in
      // SMTP is capped at a handful of mails an hour, and a confirmation step mostly adds
      // a place for this to break — so Supabase is set up with "Confirm email" off and a
      // session comes back here.
      //
      // If it does not, that setting is still on. Say so plainly rather than leaving
      // someone staring at a form that looked like it worked.
      if (!data.session) { check.value = true; return; }
    } else {
      const { error: err } = await supabase.auth.signInWithPassword({
        email: email.value.trim(),
        password: password.value,
      });
      if (err) throw err;
    }
    await navigateTo('/pack');
  } catch (e: any) {
    const raw = e?.message || 'That did not work. Try again.';
    error.value = readable(raw);
    // Offering "create account" to someone who already has one is a dead end.
    if (/already/i.test(raw)) mode.value = 'in';
  } finally {
    busy.value = false;
  }
}

useHead({ title: 'LOM — League of Managers' });
</script>

<template>
  <main class="page door">
    <header class="door__head">
      <p class="eyebrow">League of Managers</p>
      <h1>Collect the players<br>who actually played.</h1>
      <p class="door__lede">
        Every card is a real player-season from pro League of Legends — Faker 2016 and Faker
        2023 are different cards, with different champion pools and different numbers.
        One pack a day, at 17:00.
      </p>
    </header>

    <form class="panel door__form" @submit.prevent="submit">
      <div class="door__tabs" role="tablist">
        <button
          type="button" role="tab" class="chip" :aria-pressed="mode === 'in'"
          @click="mode = 'in'; error = ''"
        >Sign in</button>
        <button
          type="button" role="tab" class="chip" :aria-pressed="mode === 'up'"
          @click="mode = 'up'; error = ''"
        >Create account</button>
      </div>

      <div class="field">
        <label for="email">Email</label>
        <input
          id="email" v-model="email" type="email" autocomplete="email"
          inputmode="email" placeholder="you@example.com" required
        >
      </div>

      <div class="field">
        <label for="password">Password</label>
        <input
          id="password" v-model="password" type="password"
          :autocomplete="mode === 'up' ? 'new-password' : 'current-password'"
          placeholder="At least 8 characters" required
        >
      </div>

      <p v-if="error" class="notice notice--bad">{{ error }}</p>
      <p v-else-if="check" class="notice">
        Account created, but this project still has email confirmation switched on, so
        it is waiting on a link. Check your inbox — or turn it off in Supabase under
        <strong>Authentication &rsaquo; Providers &rsaquo; Email &rsaquo; Confirm email</strong>
        and sign in.
      </p>

      <button class="btn btn--block" type="submit" :disabled="busy">
        {{ busy ? 'One moment' : mode === 'up' ? 'Create account' : 'Sign in' }}
      </button>
    </form>

    <p class="door__foot faint">
      A private, non-commercial fan project. Not affiliated with or endorsed by Riot Games.
      Champion art from Riot's Data Dragon.
    </p>
  </main>
</template>

<style scoped>
.door {
  min-height: 100svh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 22px;
  padding-block: 32px;
}
.door__head h1 {
  font-size: clamp(30px, 8vw, 40px);
  line-height: 1.04;
  margin: 10px 0 12px;
  text-wrap: balance;
}
.door__lede { color: var(--ink-dim); max-width: 42ch; margin: 0; }
.door__form { display: grid; gap: 14px; }
.door__tabs { display: flex; gap: 6px; }
.door__foot { font-size: 12.5px; line-height: 1.6; margin: 0; }
</style>
