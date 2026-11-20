<script setup lang="ts">
import { SAMPLE_CARDS } from '~~/packages/card-engine/samples/cards.js';

/** Three real player-seasons fanned behind the door: the art, never the placeholder numbers. */
const fan = [SAMPLE_CARDS[2], SAMPLE_CARDS[4], SAMPLE_CARDS[3]];
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

/**
 * Where the door leads. Normally the pack; an invite link that was followed while
 * signed out leaves its own destination in `?next=`, and that is where a manager who
 * has just signed up to join a league has to end up.
 */
const route = useRoute();
const next = computed(() => safeNext(route.query.next));

watchEffect(() => {
  if (user.value) navigateTo(next.value);
});

async function submit() {
  error.value = '';

  if (!email.value.trim() || password.value.length < 8) {
    error.value = 'Enter your email and a password of at least 8 characters.';
    return;
  }

  busy.value = true;
  try {
    if (mode.value === 'up') {
      // Created server-side with the admin API so the account comes out already confirmed:
      // no mail, no rate limit, and no dependency on a dashboard toggle this app cannot
      // reach. Then sign in normally with the password we already have.
      await $fetch('/api/auth/signup', {
        method: 'POST',
        body: { email: email.value.trim(), password: password.value },
      });

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.value.trim(),
        password: password.value,
      });
      if (signInError) throw signInError;
    } else {
      const { error: err } = await supabase.auth.signInWithPassword({
        email: email.value.trim(),
        password: password.value,
      });
      if (err) throw err;
    }
    await navigateTo(next.value);
  } catch (e: any) {
    const raw = e?.data?.statusMessage || e?.statusMessage || e?.message
      || 'That did not work. Try again.';
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
  <main class="door">
    <section class="door__show" aria-hidden="true">
      <div class="fan">
        <div v-for="(c, i) in fan" :key="c!.cardKey" class="fan__card" :class="`fan__card--${i}`">
          <LomCard :card="c!" compact :interactive="false" />
        </div>
      </div>
    </section>

    <section class="door__panel">
      <span class="logo door__logo">
        <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M14 2l12 12-12 12L2 14z" fill="none" stroke="#d8b064" stroke-width="1.6" /><path d="M14 7.5L20.5 14 14 20.5 7.5 14z" fill="#d8b064" /></svg>
        <b>LOM</b>
      </span>

      <header class="door__head">
        <h1>Collect the players who actually played.</h1>
        <p class="door__lede">
          Every card is a real player-season from pro League of Legends. Faker 2016 and Faker 2023
          are different cards, with different champion pools and different numbers. One pack a day,
          a five to field, friends to draft against.
        </p>
      </header>

      <form class="door__form" @submit.prevent="submit">
        <div class="seg" role="tablist" aria-label="Account">
          <button type="button" role="tab" :aria-pressed="mode === 'in'" :aria-selected="mode === 'in'" @click="mode = 'in'; error = ''">Sign in</button>
          <button type="button" role="tab" :aria-pressed="mode === 'up'" :aria-selected="mode === 'up'" @click="mode = 'up'; error = ''">Create account</button>
        </div>

        <div class="field">
          <label for="email">Email</label>
          <input id="email" v-model="email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" required>
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

        <button class="btn btn--lg btn--block" type="submit" :disabled="busy">
          {{ busy ? 'One moment' : mode === 'up' ? 'Create account' : 'Sign in' }}
        </button>
      </form>

      <p class="door__foot">
        A private, non-commercial fan project. Not affiliated with or endorsed by Riot Games.
        Champion art from Riot's Data Dragon.
      </p>
    </section>
  </main>
</template>

<style scoped>
.door {
  min-height: 100svh;
  display: grid;
  align-content: center;
  gap: 8px;
  padding: max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom));
}

.door__show { display: grid; place-items: center; padding: 8px 0 4px; }
.fan { position: relative; width: 260px; height: 180px; }
.fan__card { position: absolute; top: 0; width: 112px; }
.fan__card--0 { left: 10px; top: 22px; transform: rotate(-9deg); }
.fan__card--1 { left: 74px; z-index: 2; width: 120px; }
.fan__card--2 { left: 142px; top: 22px; transform: rotate(9deg); }

.door__panel { width: 100%; max-width: 420px; margin: 0 auto; display: grid; gap: 22px; }
.door__logo { display: none; }
.door__head h1 { font-size: clamp(30px, 8vw, 46px); line-height: 0.98; font-stretch: 78%; font-weight: 850; }
.door__lede { margin: 12px 0 0; color: var(--ink-2); font-size: 14.5px; line-height: 1.55; max-width: 44ch; }
.door__form { display: grid; gap: 14px; }
.door__foot { margin: 0; font-size: 12px; line-height: 1.6; color: var(--ink-3); }

@media (min-width: 900px) {
  .door { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: center; gap: 0; padding: 0; }
  .door__show {
    min-height: 100svh;
    background: radial-gradient(60% 50% at 50% 50%, rgba(216, 176, 100, 0.08), transparent 70%);
    border-right: 1px solid var(--line-1);
  }
  .fan { width: 520px; height: 420px; }
  .fan__card { width: 220px; }
  .fan__card--0 { left: 10px; top: 60px; }
  .fan__card--1 { left: 150px; width: 236px; }
  .fan__card--2 { left: 290px; top: 60px; }
  .door__panel { padding: 48px; max-width: 480px; }
  .door__logo { display: inline-flex; }
}
</style>
