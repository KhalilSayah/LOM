<script setup lang="ts">
/**
 * One league: who is in it, when they play, and a way into each other's squads.
 *
 * The screen has two lives. While it is FORMING it is a lobby — the invite link is
 * the most important thing on it, and the schedule below is a *preview* that changes
 * as people join, so the owner can see what they are about to commit everyone to.
 * Once the season starts, the invite is gone and the top of the screen becomes the
 * next fixture, because that is the only thing anybody opens a league to check.
 *
 * The managers list is the same in both lives, and it is the part the group actually
 * uses: everyone's collection is two taps away, and a friendly is one. A friendly is
 * an ordinary duel (docs/05 section 0) — it settles nothing in the table, which is
 * exactly why it can be played at 2am without anybody's season depending on it.
 */

const route = useRoute();
const id = computed(() => String(route.params.id || ''));

const data = ref<any>(null);
const loading = ref(true);
const error = ref('');
const note = ref('');

const message = (e: any, fallback: string) =>
  e?.statusMessage || e?.data?.statusMessage || e?.data?.message || fallback;

async function load() {
  try {
    data.value = await $fetch<any>(`/api/league/${id.value}`);
    error.value = '';
  } catch (e: any) {
    error.value = message(e, 'Could not open that league.');
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const league = computed<any>(() => data.value?.league ?? null);
const members = computed<any[]>(() => data.value?.members ?? []);
const schedule = computed<any[]>(() => data.value?.schedule ?? []);

/**
 * My own five. A friendly needs one at both ends, and the server says so — but a
 * button that explains why it is disabled beats one that fails on a tap.
 */
const mine = computed<any>(() => members.value.find((m) => m.isMe) ?? null);
const iAmReady = computed(() => Boolean(mine.value?.ready));

const forming = computed(() => league.value?.status === 'FORMING');

// --- the invite --------------------------------------------------------------

/**
 * The link, built from the request's own origin rather than from configuration —
 * a preview deployment and localhost both hand out a link that works where the
 * person tapping it already is.
 */
const origin = useRequestURL().origin;
const inviteLink = computed(() =>
  (league.value?.inviteCode ? `${origin}/join/${league.value.inviteCode}` : ''));

const copied = ref(false);

async function share() {
  if (!inviteLink.value) return;
  const text = `Join ${league.value.name} on LOM — ${inviteLink.value}`;

  // The share sheet is the point on a phone: the link has to end up in a group chat,
  // and a clipboard is a worse version of that. Copy is the fallback, not the plan.
  const nav = navigator as any;
  if (nav?.share) {
    try {
      await nav.share({ title: league.value.name, text, url: inviteLink.value });
      return;
    } catch { /* dismissed; fall through to copying */ }
  }

  try {
    await navigator.clipboard.writeText(inviteLink.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 2600);
  } catch {
    note.value = inviteLink.value;
  }
}

// --- starting the season -----------------------------------------------------

const launching = ref(false);
const unready = ref<string[]>([]);

async function launch(force = false) {
  if (launching.value) return;
  launching.value = true;
  note.value = '';
  error.value = '';
  try {
    const res = await $fetch<any>(`/api/league/${id.value}/launch`, {
      method: 'POST',
      body: { ignoreUnready: force },
    });
    unready.value = [];
    note.value = `Season on. ${res.matchDays} match days, starting ${res.startsOn}.`;
    await load();
  } catch (e: any) {
    const names = e?.data?.data?.unready as string[] | undefined;
    if (names?.length) {
      unready.value = names;
      error.value = '';
    } else {
      error.value = message(e, 'Could not start the season.');
    }
  } finally {
    launching.value = false;
  }
}

// --- leaving -----------------------------------------------------------------

const leaving = ref(false);
const confirmLeave = ref(false);

async function leave() {
  if (leaving.value) return;
  leaving.value = true;
  try {
    const res = await $fetch<any>(`/api/league/${id.value}/leave`, { method: 'POST' });
    await navigateTo('/leagues');
    return res;
  } catch (e: any) {
    error.value = message(e, 'Could not leave that league.');
  } finally {
    leaving.value = false;
  }
}

// --- friendlies --------------------------------------------------------------

const challenging = ref<string | null>(null);

async function friendly(member: any) {
  if (challenging.value) return;
  challenging.value = member.profileId;
  note.value = '';
  try {
    await $fetch('/api/duel/challenge', { method: 'POST', body: { opponentId: member.profileId } });
    note.value = `Friendly sent to ${member.teamName}. It waits until they accept.`;
    await load();
  } catch (e: any) {
    error.value = message(e, 'Could not send that friendly.');
  } finally {
    challenging.value = null;
  }
}

// --- playing a fixture -------------------------------------------------------

const opening = ref(false);

/**
 * Open tonight's room.
 *
 * The same call whether nobody has opened it, the opponent opened it a second ago, or
 * a draft is already running — the endpoint is idempotent, so both managers tapping at
 * once land in one room rather than two.
 */
async function play(fixtureId: string) {
  if (opening.value) return;
  opening.value = true;
  error.value = '';
  try {
    const res = await $fetch<any>(`/api/league/${id.value}/fixture/${fixtureId}/open`, {
      method: 'POST',
    });
    await navigateTo(`/duel/${res.duelId}`);
  } catch (e: any) {
    error.value = message(e, 'Could not open that fixture.');
    await load();
  } finally {
    opening.value = false;
  }
}

// --- display -----------------------------------------------------------------

const table = computed<any[]>(() => data.value?.standings ?? []);
const last = computed<any>(() => data.value?.last ?? null);

/** A game length, as a scoreboard writes it. */
const clock = (seconds: number | null) => {
  if (!seconds) return '';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

const TIEBREAK: Record<string, string> = {
  HEAD_TO_HEAD: 'head-to-head',
  TIME: 'game time',
  KILLS: 'kills',
  COIN: 'the coin',
};

const matchDays = computed(() => schedule.value.filter((d) => !d.rest).length);

const dayLabel = (iso: string | null) => {
  if (!iso) return '';
  const at = new Date(iso);
  return at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};

const kickOff = (iso: string | null) => {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};

const isToday = (iso: string | null) =>
  Boolean(iso) && new Date(iso!).toDateString() === new Date().toDateString();

const next = computed<any>(() => data.value?.next ?? null);

/**
 * The lobby countdown. Ticks only while there is a fixture waiting on its lobby, and the
 * moment it opens the page re-reads once, so the Play button appears without a refresh.
 */
const nowMs = ref(Date.now());
let lobbyTimer: ReturnType<typeof setInterval> | undefined;
let reopened = false;
const lobbyIn = computed(() => {
  const at = next.value?.opensAt ? new Date(next.value.opensAt).getTime() : null;
  if (!at || next.value?.playable) return null;
  return Math.max(0, Math.round((at - nowMs.value) / 1000));
});
const lobbyText = computed(() => {
  const t = lobbyIn.value;
  if (t === null) return '';
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m}:${String(sec).padStart(2, '0')}`;
});
watch(lobbyIn, async (t) => {
  if (t === 0 && !reopened) {
    reopened = true;
    await load();
    reopened = false;
  }
});
onMounted(() => { lobbyTimer = setInterval(() => { nowMs.value = Date.now(); }, 1000); });
onBeforeUnmount(() => clearInterval(lobbyTimer));

const myRow = computed(() => table.value.find((r) => r.isMe) ?? null);
const ordinal = (n: number) => {
  const t = n % 100;
  if (t >= 11 && t <= 13) return n + 'th';
  return n + (n % 10 < 4 ? ['th', 'st', 'nd', 'rd'][n % 10] : 'th');
};

/** Who won it, once the season is over. */
const champion = computed(() =>
  (league.value?.status === 'FINISHED' ? table.value.find((r) => r.position === 1) ?? null : null));

useHead(() => ({ title: league.value ? `${league.value.name} — LOM` : 'League — LOM' }));
</script>

<template>
  <main class="page">
    <header class="topbar">
      <NuxtLink class="backlink" to="/leagues"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>Leagues</NuxtLink>
      <span v-if="league" class="topbar__meta">
        {{ league.memberCount }}/{{ league.maxMembers }} · {{ league.matchHour }}
      </span>
    </header>

    <p v-if="error" class="notice notice--bad">{{ error }}</p>
    <p v-if="note" class="notice">{{ note }}</p>

    <div v-if="loading" class="skeleton league-skeleton" />

    <template v-else-if="league">
      <h1 class="name">{{ league.name }}</h1>
      <p class="muted sub">
        <template v-if="forming">Forming</template>
        <template v-else-if="league.status === 'ACTIVE'">Season on since {{ league.startsOn }}</template>
        <template v-else>Finished</template>
        · {{ league.matchHour }} {{ league.timezone }}
      </p>

      <!-- The season is over: say who won before anything else. -->
      <section v-if="champion" class="season-over">
        <p class="season-over__eyebrow"><span class="gem gem--legendary" aria-hidden="true" />Season over</p>
        <p class="season-over__name">{{ champion.teamName }}</p>
        <p class="season-over__line">
          <template v-if="champion.isMe">You won the league.</template>
          <template v-else>Top of the table.</template>
          <span v-if="myRow && !champion.isMe" class="faint">You finished {{ ordinal(myRow.position) }}.</span>
        </p>
      </section>

      <!-- Tonight. The only thing most people open this screen for. -->
      <section v-if="next" class="panel next">
        <p class="eyebrow">Day {{ next.dayIndex }}</p>
        <p class="next__who">
          <strong>{{ next.opponent }}</strong>
          <span class="faint"> · {{ next.side === 'BLUE' ? 'you draft first' : 'they draft first' }}</span>
        </p>
        <p class="muted next__when">
          {{ dayLabel(next.scheduledAt) }} at {{ kickOff(next.scheduledAt) }}
        </p>

        <button
          v-if="next.playable" class="btn btn--block next__play" type="button"
          :disabled="opening" @click="play(next.id)"
        >
          {{ opening ? 'Opening' : next.duelId ? 'Back into the draft' : 'Play this fixture' }}
        </button>
        <p v-else-if="lobbyIn !== null && lobbyIn > 0" class="next__hint">
          Lobby opens in <b class="tnum next__count">{{ lobbyText }}</b>
        </p>
        <p v-else class="faint next__hint">
          The lobby opens 15 minutes before kick-off.
        </p>
      </section>

      <!-- How the last one went. -->
      <section v-if="last" class="panel block last">
        <p class="eyebrow">Day {{ last.dayIndex }}</p>
        <p class="last__line">
          <strong :class="last.result.iWon ? 'is-won' : 'is-lost'">
            {{ last.result.iWon ? 'Won' : 'Lost' }}
          </strong>
          against {{ last.opponent }}
          <span class="faint">
            · {{ last.result.blueKills }}–{{ last.result.redKills }}
            in {{ clock(last.result.gameLength) }}
          </span>
        </p>
        <NuxtLink v-if="last.duelId" class="btn btn--ghost btn--sm" :to="`/duel/${last.duelId}`">
          Watch it again
        </NuxtLink>
      </section>

      <!-- The table. Only once there is something in it. -->
      <section v-if="table.length && table.some((r) => r.played)" class="block">
        <p class="eyebrow">Table</p>
        <ol class="list standings">
          <li
            v-for="row in table" :key="row.memberId"
            class="panel standing" :class="{ 'is-me': row.isMe }"
          >
            <span class="standing__pos tnum">{{ row.position }}</span>
            <span class="standing__who">
              {{ row.teamName }}
              <span v-if="row.decidedBy && TIEBREAK[row.decidedBy]" class="faint standing__why">
                on {{ TIEBREAK[row.decidedBy] }}
              </span>
            </span>
            <span class="standing__wl tnum">{{ row.won }}–{{ row.lost }}</span>
            <span class="standing__pts tnum">{{ row.points }}</span>
          </li>
        </ol>
        <p class="faint hint">
          Three points a win. Ties go to head-to-head, then to closing wins quickly, then kills.
          Ghost fixtures are played but do not count.
        </p>
      </section>

      <!-- The invite. While forming, the most important object on the screen. -->
      <section v-if="forming && league.inviteCode" class="panel invite">
        <p class="eyebrow">Invite</p>
        <p class="invite__code tnum">{{ league.inviteCode }}</p>
        <p class="invite__link">{{ inviteLink }}</p>
        <button class="btn btn--block" type="button" @click="share">
          {{ copied ? 'Link copied' : 'Send the invite link' }}
        </button>
        <p class="faint hint">
          Anyone with this link can take one of the {{ league.maxMembers - league.memberCount }}
          remaining {{ league.maxMembers - league.memberCount === 1 ? 'seat' : 'seats' }}.
          It stops working when the season starts.
        </p>
      </section>

      <!-- The managers. The part the group actually uses. -->
      <section class="block">
        <p class="eyebrow">Managers</p>
        <p v-if="mine && !iAmReady" class="muted blurb">
          Your own five is {{ mine.rosterFilled }}/{{ mine.rosterSlots }}.
          <NuxtLink to="/roster">Set it</NuxtLink> before you can send a friendly.
        </p>
        <ul class="list">
          <li v-for="m in members" :key="m.id" class="panel manager">
            <div class="manager__top">
              <span class="manager__name">
                <strong>{{ m.teamName }}</strong>
                <span v-if="m.isOwner" class="tag">host</span>
                <span v-if="m.isMe" class="tag tag--me">you</span>
              </span>
              <span class="manager__cards tnum">{{ m.collection.total }} cards</span>
            </div>

            <p class="muted manager__best">
              <template v-if="m.collection.best">
                Best: {{ m.collection.best.playerName }}
                <template v-if="m.collection.best.season">{{ m.collection.best.season }}</template>
                · {{ m.collection.best.ovr }} OVR
              </template>
              <template v-else>No cards opened yet</template>
            </p>

            <p class="manager__ready" :class="{ 'is-ready': m.ready }">
              Roster {{ m.rosterFilled }}/{{ m.rosterSlots }}
              <span v-if="!m.ready" class="faint"> · cannot be drafted against yet</span>
            </p>

            <div class="manager__acts">
              <NuxtLink class="btn btn--quiet btn--sm" :to="`/leagues/${league.id}/m/${m.id}`">
                {{ m.isMe ? 'My squad' : 'Squad' }}
              </NuxtLink>

              <template v-if="!m.isMe">
                <NuxtLink v-if="m.duel && m.duel.status !== 'PENDING'" class="btn btn--ghost btn--sm" :to="`/duel/${m.duel.id}`">
                  Rejoin
                </NuxtLink>
                <span v-else-if="m.duel" class="faint manager__pending">
                  {{ m.duel.iChallenged ? 'Friendly sent' : 'They challenged you' }}
                </span>
                <button
                  v-else class="btn btn--ghost btn--sm" type="button"
                  :disabled="!m.ready || !iAmReady || challenging === m.profileId"
                  @click="friendly(m)"
                >
                  {{ challenging === m.profileId ? 'Sending' : 'Friendly' }}
                </button>
              </template>
            </div>
          </li>
        </ul>
      </section>

      <!-- Start season. Irreversible, so it says what it will do first. -->
      <section v-if="forming" class="panel block">
        <p class="eyebrow">Season</p>

        <p v-if="members.length < 2" class="muted blurb">
          A season needs at least two managers. Send the link.
        </p>

        <template v-else>
          <p class="muted blurb">
            {{ matchDays }} match days for {{ members.length }} managers, one fixture an evening at
            {{ league.matchHour }}, everyone against everyone twice — once from each side of the draft.
            <template v-if="schedule.some((d) => d.rest)">One rest day in the middle.</template>
          </p>

          <template v-if="league.iAmOwner">
            <p v-if="unready.length" class="notice">
              {{ unready.join(', ') }} {{ unready.length === 1 ? 'has' : 'have' }} not set a full
              roster. They can still do it before day 1.
            </p>
            <button
              class="btn btn--block" type="button" :disabled="launching"
              @click="launch(unready.length > 0)"
            >
              {{ launching ? 'Starting' : unready.length ? 'Start anyway' : 'Start season' }}
            </button>
            <p class="faint hint">
              This closes the invite link and writes the whole fixture list. It cannot be undone.
            </p>
          </template>

          <p v-else class="faint hint">
            {{ members.find((m) => m.isOwner)?.teamName || 'The host' }} starts the season.
          </p>
        </template>
      </section>

      <!-- The calendar. A preview while forming, the real thing after. -->
      <section v-if="schedule.length" class="block">
        <p class="eyebrow">
          {{ data.schedulePreview ? 'Schedule preview' : 'Schedule' }}
        </p>
        <ul class="list days">
          <li
            v-for="day in schedule" :key="day.dayIndex"
            class="panel day" :class="{ 'is-today': isToday(day.scheduledAt), 'is-rest': day.rest }"
          >
            <div class="day__head">
              <span class="day__n">Day {{ day.dayIndex }}</span>
              <span class="faint day__when">
                <template v-if="day.rest">Rest day — the pack still drops</template>
                <template v-else>{{ dayLabel(day.scheduledAt) }} · {{ kickOff(day.scheduledAt) }}</template>
              </span>
            </div>

            <ul v-if="!day.rest" class="fixtures">
              <li
                v-for="f in day.fixtures" :key="f.id"
                class="fixture" :class="{ 'is-mine': f.mine }"
              >
                <span class="fixture__side" :class="{ 'is-winner': f.result?.winnerSide === 'BLUE' }">
                  {{ f.blue.teamName }}
                </span>
                <span v-if="f.result" class="fixture__score tnum">
                  {{ f.result.blueKills }}–{{ f.result.redKills }}
                </span>
                <span v-else class="fixture__v">v</span>
                <span class="fixture__side" :class="{ 'is-winner': f.result?.winnerSide === 'RED' }">
                  {{ f.red ? f.red.teamName : 'Ghost' }}
                </span>

                <span v-if="f.result" class="fixture__after faint">
                  {{ f.result.winnerTeamName }} in {{ clock(f.result.gameLength) }}
                  <NuxtLink v-if="f.duelId" :to="`/duel/${f.duelId}`">watch</NuxtLink>
                </span>
                <button
                  v-else-if="f.playable" class="btn btn--ghost btn--sm fixture__play" type="button"
                  :disabled="opening" @click="play(f.id)"
                >
                  {{ f.duelId ? 'Rejoin' : 'Play' }}
                </button>
              </li>
            </ul>
          </li>
        </ul>
      </section>

      <!-- Leaving. Last, quiet, and only while nothing depends on it. -->
      <section v-if="forming" class="block leave">
        <button
          v-if="!confirmLeave" class="btn btn--quiet" type="button"
          @click="confirmLeave = true"
        >
          {{ league.iAmOwner ? 'Disband this league' : 'Leave this league' }}
        </button>
        <template v-else>
          <p class="muted blurb">
            {{ league.iAmOwner
              ? 'Disbanding deletes the league for everyone in it. Collections are untouched.'
              : 'You can rejoin with the invite code while the league is still forming.' }}
          </p>
          <div class="leave__acts">
            <button class="btn btn--quiet" type="button" @click="confirmLeave = false">Keep it</button>
            <button class="btn btn--danger" type="button" :disabled="leaving" @click="leave">
              {{ league.iAmOwner ? 'Disband' : 'Leave' }}
            </button>
          </div>
        </template>
      </section>
    </template>
  </main>
</template>

<style scoped>
.league-skeleton { height: 34vh; }

.backlink { display: inline-flex; align-items: center; gap: 4px; margin-left: -6px; font-size: 13.5px; font-weight: 600; color: var(--ink-2); }
.backlink svg { width: 20px; height: 20px; }
.backlink:hover { color: var(--ink-1); }

.name { font-size: clamp(30px, 7vw, 44px); line-height: 0.95; margin: 4px 0 0; }
.sub { font-size: 13px; margin: 6px 0 20px; }

/* Tonight: the focal object, so it gets the brackets. */
.next {
  padding: 20px;
  background: linear-gradient(165deg, #121b2d, #0a0f19 70%);
  border: 1px solid var(--line-1);
}
.next::before, .next::after { content: ''; position: absolute; width: 14px; height: 14px; border: 1.5px solid var(--gold-2); pointer-events: none; }
.next::before { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
.next::after { right: -1px; bottom: -1px; border-left: 0; border-top: 0; }
.next__who { font-stretch: 80%; font-weight: 820; font-size: 26px; line-height: 1.05; margin: 6px 0 0; }
.next__who .faint { font-stretch: 100%; font-weight: 500; font-size: 14px; }
.next__when { font-size: 14px; margin: 6px 0 0; }
.next__hint { font-size: 12.5px; margin: 12px 0 0; }
.next__play { margin-top: 16px; }

.last { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
.last .eyebrow { flex-basis: 100%; }
.last__line { font-size: 14.5px; margin: 0; }

.invite { margin-top: 16px; text-align: center; padding: 22px 18px; }
.invite__code { font-stretch: 85%; font-size: 40px; font-weight: 820; letter-spacing: 0.2em; margin: 8px 0 4px; }
.invite__link { font-size: 12px; color: var(--ink-3); margin: 0 0 16px; overflow-wrap: anywhere; }

.block { margin-top: 28px; }
.block > .eyebrow:first-child { font-stretch: 92%; font-weight: 720; font-size: 17px; color: var(--ink-1); margin-bottom: 12px; }
.blurb { font-size: 13.5px; margin: 6px 0 12px; }
.hint { font-size: 12px; margin: 10px 0 0; }
.list { list-style: none; padding: 0; margin: 0; display: grid; gap: 0; }

/* The table: one surface, rows split by keylines. Yours carries a marker, not a colour alone. */
.standings { border-top: 1px solid var(--line-1); }
.next__count { font-stretch: 80%; font-size: 18px; color: var(--ink-1); }
.season-over {
  margin: 4px 0 18px;
  padding: 22px 18px;
  text-align: center;
  border: 1px solid rgba(216, 178, 104, 0.45);
  border-radius: 6px;
  background: radial-gradient(120% 140% at 50% 0%, rgba(216, 178, 104, 0.18), transparent 62%), var(--bg-2);
}
.season-over__eyebrow {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 800;
  font-stretch: 116%;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--gold-1);
}
.season-over__name { margin: 8px 0 0; font-stretch: 75%; font-weight: 880; font-size: clamp(28px, 7vw, 40px); line-height: 1; text-transform: uppercase; overflow-wrap: anywhere; }
.season-over__line { margin: 10px 0 0; display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 10px; color: var(--ink-2); }
.standing {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) auto 36px;
  gap: 10px;
  align-items: baseline;
  padding: 12px 4px;
  background: none;
  border: 0;
  border-bottom: 1px solid var(--line-1);
  border-radius: 0;
}
.standing.is-me { background: var(--bg-3); }
.standing.is-me .standing__pos, .standing.is-me .standing__who { color: var(--gold-1); }
.standing__pos { font-stretch: 80%; font-weight: 800; font-size: 16px; color: var(--ink-3); text-align: center; }
.standing:first-child .standing__pos { color: var(--gold-1); }
.standing__who { font-size: 14.5px; font-weight: 620; min-width: 0; }
.standing__why { display: block; font-size: 11.5px; font-weight: 500; }
.standing__wl { font-size: 13px; color: var(--ink-2); }
.standing__pts { font-stretch: 80%; font-size: 20px; font-weight: 820; text-align: right; }

/* Managers: a list of people, not a stack of cards. */
.manager {
  display: grid;
  gap: 3px;
  padding: 14px 4px;
  background: none;
  border: 0;
  border-bottom: 1px solid var(--line-1);
  border-radius: 0;
}
.list:has(.manager) { border-top: 1px solid var(--line-1); }
.manager__top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.manager__name { font-size: 15.5px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.manager__cards { flex: none; font-size: 12.5px; font-weight: 600; color: var(--ink-3); }
.manager__best { font-size: 12.5px; margin: 0; }
.manager__ready { font-size: 12.5px; color: var(--warn-2); margin: 2px 0 0; }
.manager__ready.is-ready { color: var(--ink-3); }
.manager__acts { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.manager__pending { font-size: 12.5px; }

/* Schedule */
.days { display: grid; gap: 8px; }
.day { padding: 12px 14px; }
.day.is-today { border-color: rgba(31, 207, 193, 0.45); }
.day.is-rest { opacity: 0.65; }
.day__head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.day__n { font-stretch: 112%; font-size: 11px; font-weight: 760; letter-spacing: 0.14em; text-transform: uppercase; }
.day.is-today .day__n { color: var(--teal-1); }
.day__when { font-size: 12px; }

.fixtures { list-style: none; padding: 0; margin: 8px 0 0; display: grid; gap: 6px; }
.fixture { display: grid; grid-template-columns: 1fr auto 1fr; gap: 4px 10px; align-items: baseline; font-size: 13.5px; color: var(--ink-2); }
.fixture__score { font-stretch: 80%; font-weight: 800; font-size: 14px; color: var(--ink-1); }
/* The winner is also the only name in full-strength ink with a weight on it: never colour alone. */
.fixture__side.is-winner { color: var(--ink-1); font-weight: 700; }
.fixture__side:last-child { text-align: right; }
.fixture__v { font-size: 11px; color: var(--ink-3); }
.fixture.is-mine { color: var(--ink-1); font-weight: 600; }
.fixture__after, .fixture__play { grid-column: 1 / -1; }
.fixture__after { font-size: 11.5px; }
.fixture__play { justify-self: start; margin: 4px 0 2px; }

.leave { display: grid; justify-items: start; gap: 8px; margin-top: 28px; }
.leave__acts { display: flex; gap: 8px; }

@media (min-width: 1024px) {
  .next { padding: 28px 32px; }
  .next__who { font-size: 34px; }
}
</style>
