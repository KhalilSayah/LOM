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

const { enabled: soundOn, volume, setEnabled, setVolume } = useSound();
const LABEL: Record<string, string> = { ICON: 'Icon', LEGENDARY: 'Legendary', EPIC: 'Epic', RARE: 'Rare', COMMON: 'Common' };
const biggest = computed(() => Math.max(1, ...BANDS.map((b) => counts.value[b] || 0)));
function onVolume(e: Event) { setVolume(Number((e.target as HTMLInputElement).value)); }
</script>

<template>
  <main class="page profile">
    <header class="topbar">
      <h1>Profile</h1>
      <span class="topbar__meta">{{ user?.email }}</span>
    </header>

    <section class="me">
      <span class="me__av" aria-hidden="true">{{ (profile?.handle || user?.email || '?').slice(0, 2) }}</span>
      <div>
        <p class="me__handle">{{ profile?.handle || '—' }}</p>
        <p class="faint me__since">Manager<template v-if="profile?.created_at"> since {{ new Date(profile.created_at).toLocaleDateString([], { month: 'long', year: 'numeric' }) }}</template></p>
      </div>
    </section>

    <div class="block">
      <ShareCode :code="profile?.share_code ?? null" :handle="profile?.handle ?? null" />
    </div>

    <section class="block">
      <h2 class="sect">Collection <span class="num">{{ total }}</span></h2>
      <ul class="bands">
        <li v-for="b in BANDS" :key="b">
          <i class="gem" :class="'gem--' + b.toLowerCase()" aria-hidden="true" />
          <span class="bands__name">{{ LABEL[b] }}</span>
          <span class="meter" :class="{ 'meter--prism': b === 'ICON' }"><i :style="{ width: ((counts[b] || 0) / biggest) * 100 + '%' }" /></span>
          <b class="tnum">{{ counts[b] || 0 }}</b>
        </li>
      </ul>
      <NuxtLink class="btn btn--ghost btn--sm bands__go" to="/collection">Open Cards</NuxtLink>
    </section>

    <section class="block">
      <h2 class="sect">Sound</h2>
      <div class="panel sound">
        <div class="sound__row">
          <span><b>Game sounds</b><small class="faint">Reveals, the draft, the match</small></span>
          <button class="switch" type="button" role="switch" :aria-checked="soundOn" data-sound="none" @click="setEnabled(!soundOn)">
            <span class="switch__knob" />
          </button>
        </div>
        <label class="sound__row sound__vol" :class="{ 'is-off': !soundOn }">
          <span><b>Volume</b></span>
          <input type="range" min="0" max="1" step="0.05" :value="volume" :disabled="!soundOn" @input="onVolume" @change="playSound('coin')">
        </label>
      </div>
    </section>

    <section class="block">
      <h2 class="sect">About the numbers</h2>
      <p class="muted note">
        Cards are real player-seasons, rated from the games those players actually played.
        Match data from Oracle's Elixir, aggregated and released by Tim Sevenhuysen. The back
        of every card carries its own provenance line, including anything its season was
        measured without.
      </p>
    </section>

    <button class="btn btn--ghost btn--block profile__out" type="button" data-sound="back" @click="signOut">
      Sign out
    </button>
  </main>
</template>

<style scoped>
.me { display: flex; align-items: center; gap: 16px; padding: 6px 0 2px; }
.me__av { display: grid; place-items: center; width: 64px; height: 64px; border-radius: 50%; background: linear-gradient(135deg, #1d2a44, #0d1422); box-shadow: inset 0 0 0 1.5px var(--gold-2); font-weight: 780; font-size: 20px; text-transform: uppercase; }
.me__handle { margin: 0; font-stretch: 80%; font-weight: 820; font-size: 30px; line-height: 1; }
.me__since { margin: 4px 0 0; font-size: 13px; }

.sect { display: flex; align-items: baseline; justify-content: space-between; margin: 0 0 12px; font-stretch: 92%; font-weight: 720; font-size: 17px; }
.sect .num { font-size: 26px; }
.bands { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.bands li { display: grid; grid-template-columns: 14px 96px minmax(0, 1fr) 36px; align-items: center; gap: 12px; }
.bands__name { font-size: 14px; font-weight: 600; }
.bands b { text-align: right; }
.bands__go { margin-top: 16px; }

.sound { padding: 4px 16px; }
.sound__row { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 60px; }
.sound__row + .sound__row { border-top: 1px solid var(--line-1); }
.sound__row b { display: block; font-size: 14.5px; font-weight: 650; }
.sound__row small { display: block; font-size: 12.5px; }
.sound__vol input { width: min(220px, 50%); accent-color: var(--gold-2); }
.sound__vol.is-off { opacity: 0.5; }
.switch { position: relative; width: 48px; height: 28px; padding: 0; border: 0; border-radius: 14px; background: var(--bg-4); cursor: pointer; transition: background 0.15s ease; }
.switch[aria-checked='true'] { background: var(--teal-2); }
.switch__knob { position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%; background: var(--ink-1); transition: transform 0.18s var(--ease-out); }
.switch[aria-checked='true'] .switch__knob { transform: translateX(20px); }

.note { font-size: 13.5px; line-height: 1.6; margin: 0; }
.profile__out { margin-top: 28px; }
@media (prefers-reduced-motion: reduce) { .switch, .switch__knob { transition: none; } }
</style>
