<script setup lang="ts">
/**
 * The invite link.
 *
 * It does not join you. Joining a league is agreeing to turn up at a fixed hour
 * every evening for a fortnight, and a link that commits you to that the instant you
 * tap it in a group chat is a trap — somebody's thumb finds it while scrolling. So
 * this screen says whose league it is, who is in it and when they play, and then
 * asks.
 *
 * Already a member, following your own link back: it says so and shows the way in,
 * rather than an error about a thing you have already done.
 *
 * The team name is asked for here, because it is the name the rest of the league will
 * read in the table for a fortnight — it defaults to your display name and can be
 * changed later from the league screen.
 */
import { TEAM_NAME_MAX } from '~~/shared/league';

const route = useRoute();
const code = computed(() => String(route.params.code || ''));

const data = ref<any>(null);
const loading = ref(true);
const error = ref('');
const joining = ref(false);
/** Kept apart from the load error: a failed join reloads the preview, and the reload must not wipe why. */
const joinError = ref('');
const teamName = ref('');

const message = (e: any, fallback: string) =>
  e?.statusMessage || e?.data?.statusMessage || e?.data?.message || fallback;

async function load() {
  loading.value = true;
  try {
    data.value = await $fetch<any>('/api/league/preview', { query: { code: code.value } });
    error.value = '';
  } catch (e: any) {
    error.value = message(e, 'Could not open that invite.');
  } finally {
    loading.value = false;
  }
}

watch(code, load, { immediate: true });

async function join() {
  if (joining.value) return;
  joining.value = true;
  joinError.value = '';
  try {
    const res = await $fetch<any>('/api/league/join', {
      method: 'POST',
      body: { code: code.value, teamName: teamName.value.trim() || undefined },
    });
    await navigateTo(`/leagues/${res.league.id}`);
  } catch (e: any) {
    const why = message(e, 'Could not join that league.');
    // Re-read, because the usual reason is that the league changed under us (full,
    // started) — and the preview should say so. Then say why the tap failed.
    await load();
    joinError.value = why;
  } finally {
    joining.value = false;
  }
}

const league = computed<any>(() => data.value?.league ?? null);
const me = computed<any>(() => data.value?.me ?? null);

/** A new account: nothing opened yet, so "bring your collection" would be no help. */
const brandNew = computed(() => Boolean(me.value) && me.value.cards === 0);
const rosterShort = computed(() => Boolean(me.value) && me.value.cards > 0 && me.value.rosterFilled < me.value.rosterSlots);

useHead(() => ({
  title: league.value ? `Join ${league.value.name} — LOM` : 'Invite — LOM',
}));
</script>

<template>
  <main class="page">
    <header class="topbar">
      <NuxtLink class="backlink" to="/leagues"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>Leagues</NuxtLink>
      <span class="topbar__meta">Invite</span>
    </header>

    <p v-if="error" class="notice notice--bad">{{ error }}</p>

    <div v-if="loading" class="skeleton invite-skeleton" />

    <section v-else-if="league" class="panel invite">
      <span class="invite__tl" aria-hidden="true" /><span class="invite__br" aria-hidden="true" />
      <svg class="invite__mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v4.5a5 5 0 0 1-10 0zM7 6H4.5a2.5 2.5 0 0 0 2.6 3.4M17 6h2.5a2.5 2.5 0 0 1-2.6 3.4M12 13.5V17M8.5 20h7l-1-3h-5z" /></svg>
      <p class="eyebrow">{{ data.host }} invited you to</p>
      <h1 class="invite__name">{{ league.name }}</h1>

      <p class="muted invite__meta">
        {{ league.memberCount }} of {{ league.maxMembers }} managers ·
        matches at {{ league.matchHour }} {{ league.timezone }} ·
        about {{ league.seasonLengthDays }} days, {{ league.matchDays }} match evenings
      </p>

      <ul class="who">
        <li v-for="(m, i) in data.members" :key="i" class="who__row">
          <span class="who__av" aria-hidden="true">{{ (m.teamName || '?').slice(0, 2) }}</span>{{ m.teamName }}<span v-if="m.isOwner" class="tag">host</span>
        </li>
      </ul>

      <template v-if="data.alreadyIn">
        <p class="notice">You are already in this league.</p>
        <NuxtLink class="btn btn--block" :to="`/leagues/${league.id}`">Open it</NuxtLink>
      </template>

      <template v-else-if="league.status !== 'FORMING'">
        <p class="notice notice--bad">
          This season has already started, so the invite has closed.
        </p>
      </template>

      <template v-else-if="data.full">
        <p class="notice notice--bad">
          All {{ league.maxMembers }} seats are taken.
        </p>
      </template>

      <form v-else class="join" @submit.prevent="join">
        <div class="field join__field">
          <label for="jteam">Your team name in this league</label>
          <input
            id="jteam" v-model="teamName" :maxlength="TEAM_NAME_MAX" autocomplete="off"
            placeholder="Leave blank to use your name"
          >
        </div>

        <p v-if="joinError" class="notice notice--bad join__error" role="alert">{{ joinError }}</p>

        <button class="btn btn--lg btn--block" type="submit" data-sound="success" :disabled="joining">
          {{ joining ? 'Joining' : 'Join this league' }}
        </button>

        <p v-if="brandNew" class="notice join__first">
          You have no cards yet. Open your welcome pack in the <NuxtLink to="/shop">shop</NuxtLink>,
          then <NuxtLink to="/roster">set your five</NuxtLink> before the host starts the season.
          An empty slot is filled by a weak stand-in, so do this first.
        </p>
        <p v-else-if="rosterShort" class="notice join__first">
          Your five is {{ me.rosterFilled }}/{{ me.rosterSlots }}.
          <NuxtLink to="/roster">Fill it</NuxtLink> before the season starts. An empty slot is
          played by a weak stand-in.
          <template v-if="me.packsWaiting"> You have {{ me.packsWaiting }} unopened {{ me.packsWaiting === 1 ? 'pack' : 'packs' }} in the <NuxtLink to="/shop">shop</NuxtLink>.</template>
        </p>
        <p v-else class="faint hint">
          You bring the collection you already have. Nothing is taken from it, and you can
          leave while the league is still forming.
        </p>
      </form>
    </section>
  </main>
</template>

<style scoped>
.backlink { display: inline-flex; align-items: center; gap: 4px; margin-left: -6px; font-size: 13.5px; font-weight: 600; color: var(--ink-2); }
.backlink svg { width: 20px; height: 20px; }
.invite-skeleton { height: 30vh; }
.invite {
  max-width: 460px;
  margin: 6vh auto 0;
  padding: 32px 22px 26px;
  text-align: center;
  background: linear-gradient(165deg, #121b2d, #0a0f19 70%);
}
.invite__tl, .invite__br { position: absolute; width: 14px; height: 14px; border: 1.5px solid var(--gold-2); pointer-events: none; }
.invite__tl { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
.invite__br { right: -1px; bottom: -1px; border-left: 0; border-top: 0; }
.invite__mark { width: 40px; height: 40px; fill: none; stroke: var(--gold-2); stroke-width: 1.5; stroke-linejoin: round; margin-bottom: 10px; }
.invite__name { font-size: clamp(32px, 8vw, 44px); line-height: 0.95; margin: 8px 0 0; }
.invite__meta { font-size: 13px; margin: 10px 0 18px; }
.who { list-style: none; padding: 6px 0; margin: 0 0 18px; display: grid; gap: 0; text-align: left; border-top: 1px solid var(--line-1); }
.who__row { display: flex; align-items: center; gap: 10px; padding: 9px 2px; font-size: 14.5px; font-weight: 600; border-bottom: 1px solid var(--line-1); }
.who__av { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: var(--bg-3); box-shadow: inset 0 0 0 1px var(--line-3); font-size: 11px; font-weight: 760; text-transform: uppercase; }
.who__row .tag { margin-left: auto; }
.hint { font-size: 12.5px; margin: 12px 0 0; }
.join { display: grid; gap: 12px; text-align: left; }
.join__field input { min-height: 44px; }
.join__error, .join__first { margin: 0; font-size: 13px; }
</style>
