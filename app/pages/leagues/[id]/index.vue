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
 *
 * What the managers list no longer shows is anybody's collection: docs/01 section 4 keeps
 * it hidden from opponents. A leaguemate is their record and their form.
 */
import {
  kickOffText, dateLabel, dayWord, clockIn, ymdIn, dayGap, zoneCity, zonesDiffer,
  runtimeZone, TEAM_NAME_MAX,
} from '~~/shared/league';

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
    note.value = `Season on. ${res.matchDays} match days, starting ${dateLabel(res.startsOn)}.`;
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

/** Answer a friendly somebody in the league sent me: accept goes straight into the room. */
const answering = ref<string | null>(null);
async function answer(member: any, accept: boolean) {
  if (answering.value || !member.duel) return;
  answering.value = member.duel.id;
  error.value = '';
  try {
    const res = await $fetch<any>('/api/duel/respond', {
      method: 'POST',
      body: { duelId: member.duel.id, accept },
    });
    if (accept) {
      await navigateTo(`/duel/${res.duelId || member.duel.id}`);
      return;
    }
    await load();
  } catch (e: any) {
    error.value = message(e, accept ? 'Could not accept that friendly.' : 'Could not decline that friendly.');
    await load();
  } finally {
    answering.value = null;
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
/**
 * "Start as soon as we are both here". The draft otherwise waits for kick-off, so the
 * first manager in never starts the clock on the other. Remembered per device.
 */
const startEarly = ref(true);
onMounted(() => {
  try { startEarly.value = localStorage.getItem('lom.league.startEarly') !== '0'; } catch { /* private mode */ }
});
watch(startEarly, (v) => {
  try { localStorage.setItem('lom.league.startEarly', v ? '1' : '0'); } catch { /* private mode */ }
});

async function play(fixtureId: string, phase?: string) {
  if (opening.value) return;
  opening.value = true;
  error.value = '';
  try {
    const res = await $fetch<any>(`/api/league/${id.value}/fixture/${fixtureId}/open`, {
      method: 'POST',
      // Readiness only means something before kick-off; after it the draft is on.
      body: phase === 'LOBBY' ? { ready: startEarly.value } : {},
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

/**
 * Times, the one way the app writes them (shared/league.ts): a 24-hour clock in the
 * viewer's own zone, "Today" / "Tomorrow" / a weekday, and the league's own clock beside
 * it when the two zones read differently.
 */
const leagueTz = computed(() => league.value?.timezone || null);
const viewerTz = runtimeZone();
const tzDiffers = computed(() => {
  const sample = schedule.value.find((d) => d.scheduledAt)?.scheduledAt || Date.now();
  return zonesDiffer(sample, viewerTz, leagueTz.value);
});

const dayLabel = (iso: string | null) => (iso ? dayWord(iso, nowMs.value) : '');
const kickOff = (iso: string | null) => (iso ? clockIn(iso) : '');
/** '20:30 Paris time', only when it differs from the viewer's clock. */
const leagueClock = (iso: string | null) =>
  kickOffText(iso, { leagueTz: leagueTz.value, now: nowMs.value }).league;

/** Days from today (viewer's calendar) to a kick-off: 0 today, negative in the past. */
const daysFromToday = (iso: string | null) =>
  (iso ? dayGap(ymdIn(nowMs.value), ymdIn(iso)) : null);
const isToday = (iso: string | null) => daysFromToday(iso) === 0;

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

/** How long ago kick-off was, for a fixture that is live and not yet opened. */
const sinceKickOff = computed(() => {
  if (!next.value?.scheduledAt) return '';
  const mins = Math.max(0, Math.round((nowMs.value - new Date(next.value.scheduledAt).getTime()) / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h} h ${String(mins % 60).padStart(2, '0')} min`;
});

/** How many of my slots a stand-in would fill tonight. */
const myShortBy = computed(() => (mine.value ? mine.value.rosterSlots - mine.value.rosterFilled : 0));

// --- the calendar: today first, the past folded away -------------------------

const showPast = ref(false);

/** A day is past once its date has gone by and nothing on it is still to play. */
const isPastDay = (day: any, i: number, all: any[]): boolean => {
  if (!day.scheduledAt) {
    // A rest day: past when the next day with a kick-off is.
    const after = all.slice(i + 1).find((d) => d.scheduledAt);
    return after ? isPastDay(after, all.indexOf(after), all) : false;
  }
  const gap = daysFromToday(day.scheduledAt) ?? 0;
  return gap < 0 && day.fixtures.every((f: any) => f.result || f.status === 'VOID');
};

const pastDays = computed(() => (data.value?.schedulePreview
  ? []
  : schedule.value.filter((d, i, all) => isPastDay(d, i, all))));
const shownDays = computed(() =>
  (showPast.value ? schedule.value : schedule.value.filter((d) => !pastDays.value.includes(d))));

/** The day the calendar is about: today, or the next one with a kick-off. */
const focusDay = computed(() =>
  shownDays.value.find((d) => d.scheduledAt && (daysFromToday(d.scheduledAt) ?? -1) >= 0) ?? null);

function jumpToToday() {
  const target = focusDay.value;
  if (!target) return;
  document.getElementById(`day-${target.dayIndex}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** A human date for a calendar day: 'Today', 'Thursday', 'Sat 28 Nov'. */
const dayHeading = (iso: string | null) => (iso ? dayWord(iso, nowMs.value) : '');

/** The .ics of my fixtures. A plain link: the cookie that signs me in goes with it. */
const calendarHref = computed(() => `/api/league/${id.value}/calendar.ics`);

/** Stand-ins on a fixture, in words. */
const standInText = (f: any) => {
  const parts: string[] = [];
  for (const side of ['BLUE', 'RED'] as const) {
    const slots: string[] = f.standIns?.[side] ?? [];
    if (!slots.length) continue;
    const who = side === 'BLUE' ? f.blue?.teamName : f.red?.teamName;
    parts.push(`${who} fielded ${slots.length === 1 ? 'a stand-in' : `${slots.length} stand-ins`} (${slots.join(', ')})`);
  }
  return parts.join('; ');
};

const myRow = computed(() => table.value.find((r) => r.isMe) ?? null);
const ordinal = (n: number) => {
  const t = n % 100;
  if (t >= 11 && t <= 13) return n + 'th';
  return n + (n % 10 < 4 ? ['th', 'st', 'nd', 'rd'][n % 10] : 'th');
};

// --- the end of the season ---------------------------------------------------

const playoffs = computed<any>(() => data.value?.playoffs ?? null);
const honours = computed<any[]>(() => data.value?.honours ?? []);

/**
 * Who won it.
 *
 * The grand final, not the top of the table. They are usually the same manager and the
 * difference is the whole point of a bracket: a first seed that loses a final did not win
 * the league, and a screen that said otherwise would be arguing with the trophy.
 */
const champion = computed(() => {
  const memberId = playoffs.value?.championMemberId || league.value?.championMemberId;
  if (!memberId) return null;
  return {
    memberId,
    teamName: league.value?.championTeamName
      || members.value.find((m) => m.id === memberId)?.teamName
      || playoffs.value?.seeds?.find((s: any) => s.memberId === memberId)?.teamName
      || 'The champion',
    isMe: mine.value?.id === memberId,
  };
});

/** What I was actually paid for the season, once the ledger has paid it. */
const myHonour = computed(() => honours.value.find((h) => h.isMe) ?? null);

/** Every season this league has finished, newest first. */
const pastSeasons = computed<any[]>(() => data.value?.pastSeasons ?? []);

/**
 * Starting the next season (docs/01 section 7 point 4).
 *
 * Behind a confirmation, because it commits five other people to another fortnight of
 * evenings on the evening the last one ended — and because the obvious fear on reading the
 * button is that it wipes something, so the confirmation is where that gets answered.
 */
const confirmNextSeason = ref(false);
const starting = ref(false);

async function startNextSeason() {
  if (starting.value) return;
  starting.value = true;
  error.value = '';
  try {
    const out = await $fetch<any>(`/api/league/${id.value}/season`, { method: 'POST' });
    note.value = `Season ${out.season} starts ${dateLabel(out.startsOn)} — ${out.matchDays} match days.`;
    confirmNextSeason.value = false;
    await load();
  } catch (e: any) {
    error.value = message(e, 'Could not start the next season.');
  } finally {
    starting.value = false;
  }
}

/**
 * The owner's repair button. The bracket draws itself when the last regular fixture goes
 * FINAL; this is only here for the evening that call fails, so it is quiet and last.
 */
const drawing = ref(false);
async function drawBracket() {
  if (drawing.value) return;
  drawing.value = true;
  note.value = '';
  try {
    const out = await $fetch<any>(`/api/league/${id.value}/playoffs`, { method: 'POST' });
    note.value = out.finished
      ? 'The season is settled.'
      : out.generated ? 'The bracket is drawn.' : out.reason || 'Nothing to do yet.';
    await load();
  } catch (e: any) {
    error.value = message(e, 'Could not draw the bracket.');
  } finally {
    drawing.value = false;
  }
}

// --- my team name ------------------------------------------------------------

const renaming = ref(false);
const newName = ref('');
const savingName = ref(false);

function startRename() {
  newName.value = mine.value?.teamName || '';
  renaming.value = true;
}

async function saveName() {
  if (savingName.value) return;
  savingName.value = true;
  error.value = '';
  try {
    const res = await $fetch<any>(`/api/league/${id.value}/team`, {
      method: 'POST', body: { teamName: newName.value },
    });
    note.value = `You are ${res.teamName} in this league now.`;
    renaming.value = false;
    await load();
  } catch (e: any) {
    error.value = message(e, 'Could not rename your team.');
  } finally {
    savingName.value = false;
  }
}

// --- the owner's settings, while forming -------------------------------------

const editing = ref(false);
const settings = ref({ name: '', matchHour: '20:30', timezone: '' });
const savingSettings = ref(false);

function startEditing() {
  settings.value = {
    name: league.value?.name || '',
    matchHour: league.value?.matchHour || '20:30',
    timezone: league.value?.timezone || '',
  };
  editing.value = true;
}

async function saveSettings() {
  if (savingSettings.value) return;
  savingSettings.value = true;
  error.value = '';
  try {
    await $fetch(`/api/league/${id.value}/settings`, { method: 'POST', body: settings.value });
    note.value = 'Saved. The schedule preview has moved with it.';
    editing.value = false;
    await load();
  } catch (e: any) {
    error.value = message(e, 'Could not save those settings.');
  } finally {
    savingSettings.value = false;
  }
}

const kicking = ref<string | null>(null);
const confirmKick = ref<string | null>(null);

async function kick(member: any) {
  if (kicking.value) return;
  kicking.value = member.id;
  error.value = '';
  try {
    await $fetch(`/api/league/${id.value}/kick`, { method: 'POST', body: { memberId: member.id } });
    note.value = `${member.teamName} is out of the league. Mint a new invite code if they should not come back.`;
    confirmKick.value = null;
    await load();
  } catch (e: any) {
    error.value = message(e, 'Could not remove that manager.');
  } finally {
    kicking.value = null;
  }
}

const reminting = ref(false);
async function newCode() {
  if (reminting.value) return;
  reminting.value = true;
  error.value = '';
  try {
    const res = await $fetch<any>(`/api/league/${id.value}/invite`, { method: 'POST' });
    note.value = `New invite code ${res.inviteCode}. The old link no longer works.`;
    await load();
  } catch (e: any) {
    error.value = message(e, 'Could not mint a new code.');
  } finally {
    reminting.value = false;
  }
}

// --- activity ----------------------------------------------------------------

const feed = computed<any[]>(() => data.value?.feed ?? []);
const feedWhen = (iso: string | null) => (iso ? `${dayWord(iso, nowMs.value)} ${clockIn(iso)}` : '');

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
        <template v-else-if="league.status === 'ACTIVE'">
          <template v-if="league.season > 1">Season {{ league.season }} since</template>
          <template v-else>Season on since</template>
          {{ dateLabel(league.startsOn) }}
        </template>
        <template v-else>
          Season {{ league.season }} finished
        </template>
        · matches at {{ league.matchHour }} {{ zoneCity(league.timezone) }} time
        <template v-if="tzDiffers"> · times below are yours</template>
      </p>

      <!-- The season is over: say who won before anything else. -->
      <section v-if="champion" class="season-over">
        <p class="season-over__eyebrow"><span class="gem gem--legendary" aria-hidden="true" />Season over</p>
        <p class="season-over__name">{{ champion.teamName }}</p>
        <p class="season-over__line">
          <template v-if="champion.isMe">You won the final.</template>
          <template v-else>Champion.</template>
          <span v-if="myHonour && !champion.isMe" class="faint">
            You finished {{ ordinal(myHonour.placing) }} · {{ myHonour.credits }} Credits.
          </span>
          <span v-else-if="myHonour" class="faint">{{ myHonour.credits }} Credits.</span>
          <!-- No ledger row: the placings have not settled. Say where I came, not what I got. -->
          <span v-else-if="myRow && !champion.isMe" class="faint">
            You were {{ ordinal(myRow.position) }} in the table.
          </span>
        </p>

        <!--
          The honours board. docs/01 section 7: the champion is recorded, and the placings
          pay out — so the board shows both, because a payout nobody can read is
          indistinguishable from one that never happened.
        -->
        <ol v-if="honours.length" class="list honours">
          <li
            v-for="row in honours" :key="row.memberId"
            class="honour" :class="{ 'is-me': row.isMe }"
          >
            <span class="honour__pos tnum">{{ ordinal(row.placing) }}</span>
            <span class="honour__who">{{ row.teamName }}</span>
            <span class="honour__paid tnum">+{{ row.credits }}</span>
          </li>
        </ol>
        <p class="faint hint season-over__hint">
          Collections are kept in full. Card levels persist.
        </p>

        <!--
          docs/01 section 7 point 4. Deliberately not called a reset: season
          {{ league.season }} keeps its calendar, its results and its replays, and the next
          one begins beside it.
        -->
        <template v-if="data.canStartNextSeason">
          <button
            v-if="!confirmNextSeason" class="btn btn--block season-over__next" type="button"
            @click="confirmNextSeason = true"
          >
            Start season {{ data.nextSeason }}
          </button>
          <template v-else>
            <p class="muted blurb season-over__ask">
              A new calendar for everyone still in the league, starting tonight or tomorrow.
              Season {{ league.season }} stays where it is — nothing is wiped.
            </p>
            <div class="season-over__acts">
              <button class="btn" type="button" :disabled="starting" @click="startNextSeason">
                {{ starting ? 'Working…' : `Yes, start season ${data.nextSeason}` }}
              </button>
              <button class="btn btn--ghost" type="button" @click="confirmNextSeason = false">
                Not yet
              </button>
            </div>
          </template>
        </template>
      </section>

      <!-- Tonight. The only thing most people open this screen for. -->
      <section v-if="next" class="panel next">
        <p class="eyebrow">
          Day {{ next.dayIndex }}
          <template v-if="next.stage === 'SEMI'"> · Semi-final</template>
          <template v-else-if="next.stage === 'GRAND_FINAL'"> · Final</template>
        </p>
        <p class="next__who">
          <strong>{{ next.opponent }}</strong>
          <span class="faint"> · {{ next.side === 'BLUE' ? 'you draft first' : 'they draft first' }}</span>
        </p>
        <p class="muted next__when tnum">
          {{ dayLabel(next.scheduledAt) }} at {{ kickOff(next.scheduledAt) }}
          <span v-if="leagueClock(next.scheduledAt)" class="faint"> · {{ leagueClock(next.scheduledAt) }}</span>
        </p>

        <template v-if="next.playable">
          <button
            class="btn btn--block next__play" type="button"
            :disabled="opening" @click="play(next.id, next.phase)"
          >
            <template v-if="opening">Opening</template>
            <template v-else-if="next.duelId">Back into the room</template>
            <template v-else-if="next.phase === 'LOBBY'">Enter the lobby</template>
            <template v-else>Play this fixture</template>
          </button>

          <template v-if="next.phase === 'LOBBY'">
            <label class="next__early">
              <input v-model="startEarly" type="checkbox">
              <span>Start as soon as we are both here</span>
            </label>
            <p class="faint next__hint">
              The draft starts at kick-off, {{ kickOff(next.scheduledAt) }} — earlier only if you
              both tick this.
              <template v-if="next.side && next.ready[next.side === 'BLUE' ? 'RED' : 'BLUE'] && next.stage !== 'GHOST'">
                <b class="next__ready">{{ next.opponent }} is in and ready.</b>
              </template>
            </p>
          </template>
          <p v-else-if="next.phase === 'LIVE' && !next.duelId" class="faint next__hint">
            Kicked off {{ sinceKickOff }} ago. Whoever is not there is drafted by the agent.
            If nobody opens it within a day, the agent plays it for both of you.
          </p>
        </template>
        <p v-else-if="lobbyIn !== null && lobbyIn > 0" class="next__hint">
          Lobby opens in <b class="tnum next__count">{{ lobbyText }}</b>
        </p>
        <p v-else class="faint next__hint">
          The lobby opens 15 minutes before kick-off.
        </p>

        <p v-if="myShortBy > 0" class="notice next__short">
          Your five is {{ mine.rosterFilled }}/{{ mine.rosterSlots }}.
          {{ myShortBy === 1 ? 'A weak stand-in fills the empty slot' : `Weak stand-ins fill the ${myShortBy} empty slots` }}
          when the room opens. <NuxtLink to="/roster">Fill it</NuxtLink>.
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
          <span v-if="last.result.upset" class="tag tag--new">Upset</span>
          <span class="faint">
            · {{ last.result.blueKills }}–{{ last.result.redKills }}
            in {{ clock(last.result.gameLength) }}
          </span>
        </p>
        <NuxtLink v-if="last.canWatch" class="btn btn--ghost btn--sm" :to="`/duel/${last.duelId}`">
          Watch it again
        </NuxtLink>
        <p v-if="last.autoPlayed" class="faint last__auto">Nobody opened it within a day, so the agent drafted for both sides.</p>
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
              <NuxtLink class="standing__link" :to="`/leagues/${league.id}/m/${row.memberId}`">{{ row.teamName }}</NuxtLink>
              <span v-if="row.form?.length" class="form" :aria-label="`Form: ${row.form.join(' ')}`">
                <i v-for="(r, i) in row.form" :key="i" class="form__pip" :class="r === 'W' ? 'is-w' : 'is-l'">{{ r }}</i>
              </span>
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

      <!--
        The bracket. docs/01 section 3: semi-finals seeded off the final table, then the
        final. It appears the moment the last regular fixture is decided, and the final is
        drawn with a date on it before its two sides exist — which is what makes it
        something to look forward to rather than something that turns up.
      -->
      <section v-if="playoffs" class="block">
        <p class="eyebrow">{{ champion ? 'The bracket' : 'Playoffs' }}</p>
        <ul class="list bracket">
          <li
            v-for="m in playoffs.matches" :key="m.key"
            class="panel tie" :class="{ 'is-mine': m.mine, 'is-final': m.stage === 'GRAND_FINAL' }"
          >
            <div class="tie__head">
              <span class="tie__label">{{ m.label }} <span v-if="m.upset" class="tag tag--new">Upset</span></span>
              <span class="faint tie__when">
                <template v-if="m.status === 'FINAL'">Decided</template>
                <template v-else-if="m.scheduledAt">
                  {{ dayLabel(m.scheduledAt) }} {{ kickOff(m.scheduledAt) }}
                </template>
              </span>
            </div>

            <p class="tie__sides">
              <span
                class="tie__side"
                :class="{ 'is-winner': m.winnerMemberId && m.winnerMemberId === m.blue?.memberId }"
              >
                {{ m.blue ? m.blue.teamName : m.blueLabel }}
              </span>
              <span class="tie__v">v</span>
              <span
                class="tie__side"
                :class="{ 'is-winner': m.winnerMemberId && m.winnerMemberId === m.red?.memberId }"
              >
                {{ m.red ? m.red.teamName : m.redLabel }}
              </span>
            </p>

            <NuxtLink v-if="m.duelId" class="btn btn--ghost btn--sm tie__act" :to="`/duel/${m.duelId}`">
              {{ m.status === 'FINAL' ? 'Watch it again' : 'Back to the room' }}
            </NuxtLink>
          </li>
        </ul>

        <p class="faint hint">
          <template v-if="playoffs.seeds.length >= 4">
            Seeded off the final table: first plays fourth, second plays third. The better
            seed drafts first.
          </template>
          <template v-else-if="playoffs.seeds.length === 3">
            Three managers, so the top seed byes straight to the final and second plays third.
          </template>
          <template v-else>
            Two managers, so the final is simply first against second.
          </template>
          <template v-if="playoffs.missed.length">
            {{ playoffs.missed.map((x: any) => x.teamName).join(' and ') }} missed the cut.
          </template>
        </p>
      </section>

      <!--
        The repair button. The bracket draws itself on the server the moment the last regular
        fixture is decided; this is for the evening that call fails, which is why it is
        quiet, owner-only, and says exactly what it is.
      -->
      <section v-if="data.canDrawPlayoffs" class="block draw">
        <button class="btn btn--quiet" type="button" :disabled="drawing" @click="drawBracket">
          {{ drawing ? 'Working…' : playoffs ? 'Advance the bracket' : 'Draw the bracket' }}
        </button>
        <p class="faint hint">
          The regular season is over. The bracket is normally drawn the instant the last
          fixture is decided — press this if it was not.
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
        <button
          v-if="data.canEditSettings" class="btn btn--quiet btn--sm invite__new" type="button"
          :disabled="reminting" @click="newCode"
        >
          {{ reminting ? 'Minting' : 'New code (the old link stops working)' }}
        </button>
      </section>

      <!-- What happened lately. Derived from the fixtures and the memberships, never stored. -->
      <section v-if="feed.length > 1 || (feed.length && !forming)" class="block">
        <p class="eyebrow">Activity</p>
        <ul class="list feed">
          <li v-for="item in feed" :key="item.id" class="feed__row" :class="[`is-${item.kind.toLowerCase()}`, { 'is-me': item.isMe }]">
            <span class="feed__text">
              {{ item.text }}
              <span v-if="item.upset" class="tag tag--new">Upset</span>
              <span v-if="item.autoPlayed" class="faint"> · played by the agent</span>
            </span>
            <span class="faint feed__when tnum">{{ feedWhen(item.at) }}</span>
            <NuxtLink v-if="item.duelId" class="feed__watch" :to="`/duel/${item.duelId}`">Watch</NuxtLink>
          </li>
        </ul>
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
              <span v-if="m.record && m.record.won + m.record.lost > 0" class="manager__cards tnum">
                {{ m.record.won }}–{{ m.record.lost }}
              </span>
            </div>

            <p v-if="m.form.length" class="muted manager__best">
              <span class="form" :aria-label="`Form: ${m.form.join(' ')}`">
                <i v-for="(r, i) in m.form" :key="i" class="form__pip" :class="r === 'W' ? 'is-w' : 'is-l'">{{ r }}</i>
              </span>
            </p>

            <p class="manager__ready" :class="{ 'is-ready': m.ready }">
              Roster {{ m.rosterFilled }}/{{ m.rosterSlots }}
              <span v-if="!m.ready" class="faint"> · stand-ins fill the gaps in a fixture</span>
            </p>

            <form v-if="m.isMe && renaming" class="rename" @submit.prevent="saveName">
              <input
                v-model="newName" class="input rename__input" :maxlength="TEAM_NAME_MAX"
                aria-label="Your team name in this league" required
              >
              <button class="btn btn--sm" type="submit" :disabled="savingName">{{ savingName ? 'Saving' : 'Save' }}</button>
              <button class="btn btn--quiet btn--sm" type="button" @click="renaming = false">Cancel</button>
            </form>

            <div class="manager__acts">
              <NuxtLink class="btn btn--quiet btn--sm" :to="`/leagues/${league.id}/m/${m.id}`">
                {{ m.isMe ? 'My season' : 'Season' }}
              </NuxtLink>

              <button v-if="m.isMe && !renaming" class="btn btn--quiet btn--sm" type="button" @click="startRename">
                Rename team
              </button>

              <template v-if="!m.isMe">
                <NuxtLink v-if="m.duel && m.duel.status !== 'PENDING'" class="btn btn--ghost btn--sm" :to="`/duel/${m.duel.id}`">
                  Rejoin friendly
                </NuxtLink>
                <span v-else-if="m.duel && m.duel.iChallenged" class="faint manager__pending">Friendly sent</span>
                <template v-else-if="m.duel">
                  <button
                    class="btn btn--ghost btn--sm" type="button"
                    :disabled="answering === m.duel.id || !iAmReady" @click="answer(m, true)"
                  >
                    {{ answering === m.duel.id ? 'Answering' : 'Accept friendly' }}
                  </button>
                  <button
                    class="btn btn--quiet btn--sm" type="button"
                    :disabled="answering === m.duel.id" @click="answer(m, false)"
                  >
                    Decline
                  </button>
                </template>
                <button
                  v-else class="btn btn--ghost btn--sm" type="button"
                  :disabled="!m.ready || !iAmReady || challenging === m.profileId"
                  @click="friendly(m)"
                >
                  {{ challenging === m.profileId ? 'Sending' : 'Friendly' }}
                </button>

                <template v-if="data.canEditSettings">
                  <button
                    v-if="confirmKick !== m.id" class="btn btn--quiet btn--sm manager__kick" type="button"
                    @click="confirmKick = m.id"
                  >
                    Remove
                  </button>
                  <template v-else>
                    <button class="btn btn--danger btn--sm" type="button" :disabled="kicking === m.id" @click="kick(m)">
                      {{ kicking === m.id ? 'Removing' : `Remove ${m.teamName}` }}
                    </button>
                    <button class="btn btn--quiet btn--sm" type="button" @click="confirmKick = null">Keep</button>
                  </template>
                </template>
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
            {{ league.matchHour }} {{ zoneCity(league.timezone) }} time, everyone against everyone
            twice — once from each side of the draft.
            <template v-if="league.shape.restDays === 1">One rest day in the middle,</template>
            <template v-else-if="league.shape.restDays > 1">{{ league.shape.restDays }} rest days,</template>
            then {{ league.shape.playoffDays === 1 ? 'a final' : 'the playoffs' }}: about
            {{ league.shape.totalDays }} days in all. The length follows the number of managers.
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

        <!-- The owner's settings. They lock at Start season. -->
        <div v-if="data.canEditSettings" class="settings">
          <button v-if="!editing" class="btn btn--quiet btn--sm" type="button" @click="startEditing">
            Change name, hour or timezone
          </button>
          <form v-else class="settings__form" @submit.prevent="saveSettings">
            <div class="field">
              <label for="sname">League name</label>
              <input id="sname" v-model="settings.name" maxlength="40" required>
            </div>
            <div class="settings__row">
              <div class="field">
                <label for="shour">Match hour</label>
                <input id="shour" v-model="settings.matchHour" type="time" required>
              </div>
              <div class="field">
                <label for="stz">Timezone</label>
                <input id="stz" v-model="settings.timezone" placeholder="Europe/Paris" required>
              </div>
            </div>
            <div class="settings__acts">
              <button class="btn btn--quiet" type="button" @click="editing = false">Cancel</button>
              <button class="btn btn--ghost" type="submit" :disabled="savingSettings">
                {{ savingSettings ? 'Saving' : 'Save' }}
              </button>
            </div>
          </form>
        </div>
      </section>

      <!-- The calendar. A preview while forming, the real thing after. -->
      <section v-if="schedule.length" class="block">
        <div class="cal__head">
          <p class="eyebrow">
            {{ data.schedulePreview ? 'Schedule preview' : 'Schedule' }}
          </p>
          <div class="cal__acts">
            <button v-if="focusDay && !data.schedulePreview" class="btn btn--quiet btn--sm" type="button" @click="jumpToToday">
              {{ isToday(focusDay.scheduledAt) ? 'Today' : 'Next match day' }}
            </button>
            <a
              v-if="!data.schedulePreview" class="btn btn--quiet btn--sm" :href="calendarHref"
              download data-sound="none"
            >Add to calendar</a>
          </div>
        </div>
        <p class="faint hint cal__tz">
          Times are yours<template v-if="viewerTz"> ({{ zoneCity(viewerTz) }})</template>, 24-hour.
          <template v-if="tzDiffers">The league plays at {{ league.matchHour }} {{ zoneCity(league.timezone) }} time.</template>
        </p>

        <button
          v-if="pastDays.length" class="btn btn--quiet btn--sm cal__past" type="button"
          :aria-expanded="showPast" @click="showPast = !showPast"
        >
          {{ showPast ? 'Hide' : 'Show' }} {{ pastDays.length }} past {{ pastDays.length === 1 ? 'day' : 'days' }}
        </button>

        <ul class="list days">
          <li
            v-for="day in shownDays" :id="`day-${day.dayIndex}`" :key="day.dayIndex"
            class="panel day" :class="{ 'is-today': isToday(day.scheduledAt), 'is-rest': day.rest }"
          >
            <div class="day__head">
              <span class="day__n">Day {{ day.dayIndex }}<template v-if="isToday(day.scheduledAt)"> · today</template></span>
              <span class="faint day__when tnum">
                <template v-if="day.rest">Rest day — the pack still drops</template>
                <template v-else>
                  {{ dayHeading(day.scheduledAt) }} {{ kickOff(day.scheduledAt) }}
                  <template v-if="leagueClock(day.scheduledAt)"> · {{ leagueClock(day.scheduledAt) }}</template>
                </template>
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
                  <span v-if="f.result.upset" class="tag tag--new">Upset</span>
                  <template v-if="f.autoPlayed"> · played by the agent</template>
                  <NuxtLink v-if="f.canWatch" :to="`/duel/${f.duelId}`">watch</NuxtLink>
                </span>
                <span v-else-if="f.status === 'PLAYING'" class="fixture__after faint">Being played now</span>
                <button
                  v-else-if="f.playable" class="btn btn--ghost btn--sm fixture__play" type="button"
                  :disabled="opening" @click="play(f.id, f.phase)"
                >
                  {{ f.duelId ? 'Rejoin' : f.phase === 'LOBBY' ? 'Enter the lobby' : 'Play' }}
                </button>
                <span v-if="standInText(f)" class="fixture__after faint">{{ standInText(f) }}.</span>
              </li>
            </ul>
          </li>
        </ul>
      </section>

      <!--
        Past seasons. Only once there is more than this one to show, so a league in its
        first season is not given an empty trophy cabinet to look at.
      -->
      <section v-if="pastSeasons.length > 1 || (pastSeasons.length && league.status !== 'FINISHED')" class="block">
        <p class="eyebrow">Honours</p>
        <ul class="list seasons">
          <li
            v-for="row in pastSeasons" :key="row.season"
            class="season-row" :class="{ 'is-current': row.current }"
          >
            <span class="season-row__n tnum">Season {{ row.season }}</span>
            <span class="season-row__who">
              <template v-if="row.championTeamName">
                {{ row.championTeamName }}
                <span v-if="row.iWon" class="faint">· you</span>
              </template>
              <span v-else class="faint">No champion recorded</span>
            </span>
            <span class="faint season-row__when">{{ row.matchDays ? `${row.matchDays} match days` : '' }}</span>
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

/* The honours board, inside the season-over banner: a short ranked list, gold at the top. */
.honours { margin: 16px 0 0; border-top: 1px solid rgba(216, 178, 104, 0.3); text-align: left; }
.honour {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: baseline;
  padding: 9px 2px;
  background: none;
  border: 0;
  border-bottom: 1px solid rgba(216, 178, 104, 0.18);
  border-radius: 0;
}
.honour.is-me .honour__who, .honour.is-me .honour__pos { color: var(--gold-1); }
.honour:first-child .honour__pos { color: var(--gold-1); }
.honour__pos { font-stretch: 80%; font-weight: 800; font-size: 12.5px; color: var(--ink-3); }
.honour__who { font-size: 14px; font-weight: 620; min-width: 0; overflow-wrap: anywhere; }
.honour__paid { font-stretch: 80%; font-size: 14px; font-weight: 800; color: var(--ink-2); }
.season-over__hint { text-align: center; }

/* The bracket: two or three ties, the final weighted like a final. */
.bracket { display: grid; gap: 8px; }
.tie { padding: 13px 14px; }
.tie.is-mine { border-color: rgba(31, 207, 193, 0.4); }
.tie.is-final { border-color: rgba(216, 178, 104, 0.45); }
.tie__head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.tie__label { font-stretch: 112%; font-size: 11px; font-weight: 760; letter-spacing: 0.14em; text-transform: uppercase; }
.tie.is-final .tie__label { color: var(--gold-1); }
.tie__when { font-size: 12px; }
.tie__sides {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 4px 10px;
  align-items: baseline;
  margin: 8px 0 0;
  font-size: 14px;
  color: var(--ink-2);
}
.tie.is-final .tie__sides { font-size: 15.5px; }
.tie__side { min-width: 0; overflow-wrap: anywhere; }
.tie__side:last-child { text-align: right; }
/* The winner carries weight and full-strength ink, never a colour alone. */
.tie__side.is-winner { color: var(--ink-1); font-weight: 750; }
.tie__v { font-size: 11px; color: var(--ink-3); }
.tie__act { margin-top: 10px; }

.draw { display: grid; justify-items: start; gap: 6px; }

.season-over__next { margin-top: 18px; }
.season-over__ask { margin-top: 16px; text-align: left; }
.season-over__acts { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
/* A phone: the banner is a stack — the name breaks rather than overflows, and the two
   season buttons are full-width rows rather than a pair squeezed side by side. */
@media (max-width: 520px) {
  .season-over { padding: 20px 14px; }
  .season-over__line { flex-direction: column; gap: 4px; }
  .season-over__acts { flex-direction: column; }
  .season-over__acts .btn { width: 100%; min-height: 44px; }
  .honour { grid-template-columns: 38px minmax(0, 1fr) auto; }
}

.next__early { display: flex; align-items: center; gap: 10px; min-height: 44px; margin-top: 8px; font-size: 13.5px; color: var(--ink-2); cursor: pointer; }
.next__early input { width: 20px; height: 20px; accent-color: var(--teal-2); }
.next__ready { display: block; margin-top: 4px; color: var(--ink-1); font-weight: 650; }
.next__short { margin: 14px 0 0; font-size: 13px; }
.last__auto { flex-basis: 100%; font-size: 12px; margin: 0; }

/* Form: the letter carries it, not the colour alone. */
.form { display: inline-flex; gap: 3px; vertical-align: 1px; }
.form__pip {
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 2px;
  font-style: normal;
  font-stretch: 80%;
  font-weight: 820;
  font-size: 11px;
}
.form__pip.is-w { background: var(--bg-3); color: var(--ink-1); box-shadow: inset 0 0 0 1px var(--line-3); }
.form__pip.is-l { color: var(--ink-3); box-shadow: inset 0 0 0 1px var(--line-2); }
.standing__who .form { margin-left: 8px; }
.standing__link { color: inherit; text-decoration: none; }
.standing__link:hover { text-decoration: underline; }

.invite__new { margin-top: 12px; }

.rename { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.rename__input { flex: 1 1 160px; min-height: 40px; font-size: 16px; }
.manager__acts { flex-wrap: wrap; }
.manager__kick { margin-left: auto; }

.settings { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line-1); }
.settings__form { display: grid; gap: 12px; }
.settings__row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.settings__acts { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 420px) { .settings__row { grid-template-columns: 1fr; } }

.cal__head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.cal__head .eyebrow { font-stretch: 92%; font-weight: 720; font-size: 17px; color: var(--ink-1); margin: 0; }
.cal__acts { display: flex; flex-wrap: wrap; gap: 6px; }
.cal__tz { margin: 0 0 10px; }
.cal__past { margin-bottom: 8px; }
.day { scroll-margin-top: calc(var(--appbar-h, 56px) + 12px); }

.feed { border-top: 1px solid var(--line-1); }
.feed__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 10px;
  align-items: baseline;
  padding: 10px 4px;
  border-bottom: 1px solid var(--line-1);
  font-size: 13.5px;
  color: var(--ink-2);
}
.feed__row.is-me .feed__text { color: var(--ink-1); }
.feed__row.is-champion .feed__text { color: var(--gold-1); font-weight: 700; }
.feed__row.is-bracket .feed__text, .feed__row.is-season .feed__text { font-weight: 650; }
.feed__text { min-width: 0; overflow-wrap: anywhere; }
.feed__when { font-size: 11.5px; white-space: nowrap; }
.feed__watch { grid-column: 1 / -1; font-size: 12.5px; justify-self: start; }

/* Honours: one line per season, the current one marked rather than coloured. */
.seasons { border-top: 1px solid var(--line-1); }
.season-row {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: baseline;
  padding: 12px 4px;
  border-bottom: 1px solid var(--line-1);
}
.season-row.is-current { background: var(--bg-3); }
.season-row__n { font-stretch: 112%; font-size: 11px; font-weight: 760; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-3); }
.season-row.is-current .season-row__n { color: var(--gold-1); }
.season-row__who { font-size: 14.5px; font-weight: 620; min-width: 0; overflow-wrap: anywhere; }
.season-row__when { font-size: 12px; }

.leave { display: grid; justify-items: start; gap: 8px; margin-top: 28px; }
.leave__acts { display: flex; gap: 8px; }

@media (min-width: 1024px) {
  .next { padding: 28px 32px; }
  .next__who { font-size: 34px; }
}
</style>
