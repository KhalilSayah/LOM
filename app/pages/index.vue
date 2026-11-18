<script setup lang="ts">
const supabase = useSupabaseClient();
const user = useSupabaseUser();

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
      // With email confirmation on, there is no session yet and the manager has mail.
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
    error.value = e?.message || 'That did not work. Try again.';
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
        Check your inbox. The link signs you in and brings you straight back here.
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
