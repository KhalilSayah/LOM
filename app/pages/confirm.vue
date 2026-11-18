<script setup lang="ts">
/**
 * Where the confirmation link lands.
 *
 * Supabase's mail sends the manager to its own /auth/v1/verify endpoint, which checks the
 * token and then redirects here. The Supabase browser client picks the session out of the
 * URL on load, so there is nothing to exchange by hand — this page waits for that to
 * happen and then gets out of the way.
 *
 * It exists because without it the link lands on a 404 and the account looks broken when
 * it is, in fact, confirmed.
 */
const user = useSupabaseUser();
const route = useRoute();

const failed = ref<string | null>(null);
const slow = ref(false);

// Supabase reports a refused link in the query or the hash, depending on the flow.
function urlError(): string | null {
  const q = route.query;
  const hash = new URLSearchParams((route.hash || '').replace(/^#/, ''));
  const code = (q.error_code || q.error || hash.get('error_code') || hash.get('error')) as string | null;
  const description = (q.error_description || hash.get('error_description')) as string | null;
  if (!code) return null;
  if (/expired/i.test(`${code} ${description}`)) {
    return 'That link has expired. Sign in to have a new one sent.';
  }
  return description ? String(description).replace(/\+/g, ' ') : 'That link could not be used.';
}

watchEffect(() => {
  if (user.value) navigateTo('/pack');
});

onMounted(() => {
  failed.value = urlError();
  if (failed.value) return;
  // The client resolves the session on load; if nothing has arrived by now the link was
  // already used or belongs to another browser.
  setTimeout(() => { slow.value = true; }, 2500);
  setTimeout(() => {
    if (!user.value) failed.value = 'This link did not sign you in. It may already have been used.';
  }, 7000);
});

useHead({ title: 'Confirming — LOM' });
</script>

<template>
  <main class="page confirm">
    <template v-if="failed">
      <h1>Not signed in</h1>
      <p class="muted">{{ failed }}</p>
      <NuxtLink class="btn" to="/">Back to sign in</NuxtLink>
    </template>

    <template v-else>
      <span class="confirm__spinner" aria-hidden="true" />
      <h1>Confirming your account</h1>
      <p class="muted">{{ slow ? 'Still working on it.' : 'One moment.' }}</p>
    </template>
  </main>
</template>

<style scoped>
.confirm {
  min-height: 100svh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  text-align: center;
}
.confirm h1 { font-size: 24px; }
.confirm p { margin: 0; max-width: 40ch; }
.confirm__spinner {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 2px solid var(--line-strong);
  border-top-color: var(--accent);
  animation: spin 0.9s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .confirm__spinner { animation: none; border-top-color: var(--accent); }
}
</style>
