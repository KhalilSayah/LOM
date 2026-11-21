<script setup lang="ts">
/**
 * Profile: who you are to other managers, and what you hold.
 *
 * Names come from /api/profile/me (profiles are not writable from the client, and reading
 * through the same route keeps the name step, Settings and this screen agreeing). The
 * collection tally reads Postgres directly, as the Cards screen does.
 *
 * Loading and failure are shown as such. Before, a failed read looked exactly like a brand
 * new account — handle "—" and zero cards — which is the worst thing a profile can say.
 */
const supabase = useSupabaseClient();
const user = useSupabaseUser();
const managerId = useManagerId();
const signOut = useSignOut();

const profile = ref<any>(null);
const counts = ref<Record<string, number>>({});
const total = ref(0);
const loading = ref(true);
const error = ref('');

const BANDS = ['ICON', 'LEGENDARY', 'EPIC', 'RARE', 'COMMON'];

async function load() {
  if (!managerId.value) return;
  loading.value = true;
  error.value = '';
  try {
    const [me, cards] = await Promise.all([
      $fetch<{ profile: any }>('/api/profile/me'),
      supabase.from('collection_cards').select('card_definitions(rarity)').eq('profile_id', managerId.value),
    ]);
    if (cards.error) throw cards.error;
    profile.value = me.profile;
    const tally: Record<string, number> = {};
    for (const r of (cards.data || []) as any[]) {
      const band = r.card_definitions?.rarity;
      if (band) tally[band] = (tally[band] || 0) + 1;
    }
    counts.value = tally;
    total.value = (cards.data || []).length;
  } catch (e: any) {
    error.value = e?.data?.statusMessage || 'Your profile could not be loaded. Check your connection and try again.';
  } finally {
    loading.value = false;
  }
}

watch(managerId, load, { immediate: true });

const leaving = ref(false);
async function leave() {
  leaving.value = true;
  await signOut();
}

useHead({ title: 'Profile — LOM' });

const LABEL: Record<string, string> = { ICON: 'Icon', LEGENDARY: 'Legendary', EPIC: 'Epic', RARE: 'Rare', COMMON: 'Common' };
const biggest = computed(() => Math.max(1, ...BANDS.map((b) => counts.value[b] || 0)));
const since = computed(() => (profile.value?.createdAt
  ? new Date(profile.value.createdAt).toLocaleDateString([], { month: 'long', year: 'numeric' })
  : null));
</script>

<template>
  <main class="page profile">
    <header class="topbar">
      <h1>Profile</h1>
      <NuxtLink class="topbar__meta profile__settings" to="/settings">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" /></svg>
        Settings
      </NuxtLink>
    </header>

    <div v-if="error" class="notice notice--bad profile__error" role="alert">
      <span>{{ error }}</span>
      <button class="btn btn--ghost btn--sm" type="button" @click="load">Try again</button>
    </div>

    <template v-if="loading">
      <div class="me" aria-busy="true">
        <span class="skeleton me__av" />
        <div class="me__skel"><span class="skeleton" /><span class="skeleton" /></div>
      </div>
      <span class="sr-only" role="status">Loading your profile</span>
      <div class="skeleton profile__skel" />
      <div class="skeleton profile__skel profile__skel--tall" />
    </template>

    <template v-else-if="profile">
      <section class="me">
        <span class="me__av" aria-hidden="true">{{ (profile.displayName || profile.handle).slice(0, 2) }}</span>
        <div class="me__who">
          <p class="me__handle">{{ profile.displayName }}</p>
          <p class="faint me__since">@{{ profile.handle }}<template v-if="since"> · manager since {{ since }}</template></p>
        </div>
      </section>

      <p v-if="!profile.handleChosen" class="notice profile__nudge">
        <span>You are playing under a name we picked. <strong>Choose your own</strong> so friends can find you.</span>
        <NuxtLink class="btn btn--sm btn--ghost" to="/settings#name">Choose</NuxtLink>
      </p>

      <div class="block">
        <ShareCode :code="profile.shareCode" :handle="profile.handle" />
      </div>

      <section class="block">
        <h2 class="sect">Collection <span class="num">{{ total }}</span></h2>
        <ul class="bands">
          <li v-for="b in BANDS" :key="b">
            <i class="gem" :class="'gem--' + b.toLowerCase()" aria-hidden="true" />
            <span class="bands__name">{{ LABEL[b] }}</span>
            <span class="meter" :class="{ 'meter--prism': b === 'ICON' }" aria-hidden="true"><i :style="{ width: ((counts[b] || 0) / biggest) * 100 + '%' }" /></span>
            <b class="tnum">{{ counts[b] || 0 }}</b>
          </li>
        </ul>
        <NuxtLink class="btn btn--ghost btn--sm bands__go" to="/collection">Open Cards</NuxtLink>
      </section>
    </template>

    <nav class="block links" aria-label="More">
      <NuxtLink class="links__row" to="/settings">
        <span><b>Settings</b><small class="faint">Name, password, sound, motion</small></span>
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
      </NuxtLink>
      <NuxtLink class="links__row" to="/how-to-play">
        <span><b>How to play</b><small class="faint">The loop in five steps</small></span>
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
      </NuxtLink>
    </nav>

    <section class="block">
      <h2 class="sect">About the numbers</h2>
      <p class="muted note">
        Cards are real player-seasons, rated from the games those players actually played.
        Match data from Oracle's Elixir, aggregated and released by Tim Sevenhuysen. The back
        of every card carries its own provenance line, including anything its season was
        measured without.
      </p>
    </section>

    <p class="faint profile__email">Signed in as {{ user?.email }}</p>
    <button class="btn btn--ghost btn--block profile__out" type="button" data-sound="back" :disabled="leaving" @click="leave">
      {{ leaving ? 'Signing out' : 'Sign out' }}
    </button>
  </main>
</template>

<style scoped>
.profile__settings { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; }
.profile__settings svg { width: 18px; height: 18px; }
.profile__error, .profile__nudge { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.profile__skel { height: 92px; margin-top: 24px; }
.profile__skel--tall { height: 180px; }

.me { display: flex; align-items: center; gap: 16px; padding: 6px 0 2px; }
.me__av { display: grid; place-items: center; flex: none; width: 64px; height: 64px; border-radius: 50%; background: linear-gradient(135deg, #1d2a44, #0d1422); box-shadow: inset 0 0 0 1.5px var(--gold-2); font-weight: 780; font-size: 20px; text-transform: uppercase; }
.me__who { min-width: 0; }
.me__handle { margin: 0; font-stretch: 80%; font-weight: 820; font-size: 30px; line-height: 1; overflow-wrap: anywhere; }
.me__since { margin: 4px 0 0; font-size: 13px; }
.me__skel { display: grid; gap: 8px; flex: 1; }
.me__skel span { display: block; height: 22px; width: 60%; }
.me__skel span + span { height: 14px; width: 40%; }
.profile__nudge { margin-top: 16px; }

.sect { display: flex; align-items: baseline; justify-content: space-between; margin: 0 0 12px; font-stretch: 92%; font-weight: 720; font-size: 17px; }
.sect .num { font-size: 26px; }
.bands { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.bands li { display: grid; grid-template-columns: 14px 96px minmax(0, 1fr) 36px; align-items: center; gap: 12px; }
.bands__name { font-size: 14px; font-weight: 600; }
.bands b { text-align: right; }
.bands__go { margin-top: 16px; }

.links { display: grid; border: 1px solid var(--line-1); border-radius: var(--radius); background: var(--bg-2); }
.links__row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 60px; padding: 8px 16px; }
.links__row + .links__row { border-top: 1px solid var(--line-1); }
.links__row b { display: block; font-size: 14.5px; font-weight: 650; }
.links__row small { display: block; font-size: 12.5px; }
.links__row svg { width: 18px; height: 18px; color: var(--ink-3); }
@media (hover: hover) and (pointer: fine) { .links__row:hover { background: var(--bg-3); } }

.note { font-size: 13.5px; line-height: 1.6; margin: 0; }
.profile__email { margin: 28px 0 10px; font-size: 12.5px; text-align: center; overflow-wrap: anywhere; }
</style>
