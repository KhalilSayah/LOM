<script setup lang="ts">
const supabase = useSupabaseClient();
const user = useSupabaseUser();
const managerId = useManagerId();

const profile = ref<any>(null);
const counts = ref<Record<string, number>>({});
const total = ref(0);

const BANDS = ['ICON', 'LEGENDARY', 'EPIC', 'RARE', 'COMMON'];

async function load() {
  if (!managerId.value) return;
  const [{ data: p }, { data: rows }] = await Promise.all([
    supabase.from('profiles').select('handle, display_name, share_code, created_at').eq('id', managerId.value).maybeSingle(),
    supabase.from('collection_cards').select('card_definitions(rarity)').eq('profile_id', managerId.value),
  ]);
  profile.value = p;
  const tally: Record<string, number> = {};
  for (const r of (rows || []) as any[]) {
    const band = r.card_definitions?.rarity;
    if (band) tally[band] = (tally[band] || 0) + 1;
  }
  counts.value = tally;
  total.value = (rows || []).length;
}

watch(managerId, load, { immediate: true });

async function signOut() {
  await supabase.auth.signOut();
  await navigateTo('/');
}

useHead({ title: 'Profile — LOM' });
</script>

<template>
  <main class="page">
    <header class="topbar">
      <h1>Profile</h1>
    </header>

    <section class="panel">
      <p class="eyebrow">Manager</p>
      <p class="profile__handle">{{ profile?.handle || '—' }}</p>
      <p class="muted profile__email">{{ user?.email }}</p>
    </section>

    <div class="profile__block">
      <ShareCode :code="profile?.share_code ?? null" :handle="profile?.handle ?? null" />
    </div>

    <section class="panel profile__block">
      <p class="eyebrow">Collection</p>
      <p class="profile__total tnum">{{ total }}</p>
      <ul class="bands">
        <li v-for="b in BANDS" :key="b">
          <span class="rarity-dot" :class="`is-${b.toLowerCase()}`" />
          <span class="bands__name">{{ b.toLowerCase() }}</span>
          <span class="bands__n tnum">{{ counts[b] || 0 }}</span>
        </li>
      </ul>
    </section>

    <section class="panel profile__block">
      <p class="eyebrow">About the numbers</p>
      <p class="muted profile__note">
        Cards are real player-seasons, rated from the games those players actually played.
        Match data from Oracle's Elixir, aggregated and released by Tim Sevenhuysen. The back
        of every card carries its own provenance line, including anything its season was
        measured without.
      </p>
    </section>

    <button class="btn btn--ghost btn--block profile__out" type="button" @click="signOut">
      Sign out
    </button>
  </main>
</template>

<style scoped>
.profile__handle { font-family: var(--font-display); font-size: 26px; font-weight: 700; margin: 6px 0 0; }
.profile__email { font-size: 14px; margin: 2px 0 0; }
.profile__block { margin-top: 12px; }
.profile__total { font-family: var(--font-display); font-size: 34px; font-weight: 700; margin: 4px 0 10px; }
.profile__note { font-size: 13.5px; line-height: 1.6; margin: 8px 0 0; }
.bands { list-style: none; margin: 0; padding: 0; display: grid; gap: 7px; }
.bands li { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; align-items: center; gap: 10px; }
.bands__name {
  font-family: var(--font-label);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-dim);
}
.bands__n { font-weight: 700; }
.profile__out { margin-top: 18px; }
</style>
