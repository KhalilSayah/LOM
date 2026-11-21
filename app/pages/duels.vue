<script setup lang="ts">
/**
 * Battle.
 *
 * One button, the size of a thumb, in the middle of the screen. That is the whole brief and
 * everything else on this page is secondary to it — because the thing the old duels screen
 * got wrong was not its layout, it was asking you to go and find somebody first. A list of
 * challenges you have sent is a to-do list. A button that puts you in a game is a game.
 *
 * What is below it, in order: the room you are already in (because being put back into it
 * matters more than anything else here), friendlies waiting on an answer, and what you have
 * played. Finding a specific manager to challenge still exists and is deliberately one line
 * of text rather than a second button — it is the rarer intention now.
 */

import { DIFFICULTIES, DIFFICULTY_LABEL, asDifficulty, type Difficulty } from '~~/shared/duelRoom';

const {
  searching, waiting, elapsed, botOffered, error: queueError, busy, liveRoomId,
  search, cancel, playBot, restore,
} = useDuelQueue();

const route = useRoute();
const data = ref<any>(null);
const loading = ref(true);
const listError = ref('');
const notice = ref('');
const responding = ref<string | null>(null);
const challenging = ref<string | null>(null);

const error = computed(() => queueError.value || listError.value);

/**
 * Practice against the agent, straight from here. Easy, Normal or Hard changes how carefully
 * it drafts and how strong a five it brings (server/utils/duel.ts AGENT_PROFILES). Nothing
 * played in practice counts anywhere.
 */
const difficulty = ref<Difficulty>('NORMAL');
function practice() {
  playBot(difficulty.value);
}
const difficultyLabel = (d: string | null) => DIFFICULTY_LABEL[asDifficulty(d)];

/**
 * Which lanes are still empty. The queue refuses an incomplete five anyway; asking first
 * means the big button sends you to fix it instead of to an error.
 */
const missing = ref<string[]>([]);
const ROLE_NAME: Record<string, string> = { TOP: 'top', JNG: 'jungle', MID: 'mid', BOT: 'bot', SUP: 'support' };
async function loadRoster() {
  try {
    const r = await $fetch<any>('/api/roster');
    missing.value = Object.keys(ROLE_NAME).filter((role) => !r?.roster?.[role]);
  } catch {
    missing.value = [];
  }
}

/**
 * The record, worked out on the server over far more games than this screen lists.
 *
 * Battles — the queue, people against people — first, with the streak. Friendlies, practice
 * and league games are shown apart and smaller: there is no ladder, and a record that mixes
 * "beat the agent on Easy" into "beat a person" says nothing about either.
 */
const record = computed(() => data.value?.record ?? null);
const battles = computed(() => record.value?.battles ?? { wins: 0, losses: 0, streak: 0, streakWon: false, played: 0 });
const otherRecords = computed(() => {
  const r = record.value;
  if (!r) return [];
  return [
    { label: 'Friendlies', ...r.friendlies },
    { label: 'Practice', ...r.practice },
    { label: 'League', ...r.league },
  ].filter((x) => x.played > 0);
});
const opponents = computed<any[]>(() => data.value?.opponents ?? []);

/** One tap to play somebody again. If they had already challenged you, it starts. */
async function challenge(opponentId: string, name: string) {
  if (challenging.value) return;
  challenging.value = opponentId;
  notice.value = '';
  listError.value = '';
  try {
    const res = await $fetch<any>('/api/duel/challenge', { method: 'POST', body: { opponentId } });
    if (res?.accepted && res.duelId) return navigateTo(`/duel/${res.duelId}`);
    notice.value = `Challenge sent to ${name}. It starts when they accept, and expires after a day.`;
    await load();
  } catch (e: any) {
    listError.value = e?.data?.statusMessage || e?.message || 'Could not send that challenge.';
  } finally {
    challenging.value = null;
  }
}

const SOURCE_NAME: Record<string, string> = { LEAGUE: 'League', CHALLENGE: 'Friendly', QUEUE: 'Battle', BOT: 'Practice' };
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
function ago(iso: string | null) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/**
 * A room you are already in. Being put back into it beats starting another — but it is
 * offered, not forced: this screen used to navigate into it on sight, which made history,
 * challenges and the record unreachable for the length of a match.
 */
const liveRoom = computed(() => {
  const listed = data.value?.live?.[0];
  if (listed) return listed;
  return liveRoomId.value ? { id: liveRoomId.value, opponent: 'your opponent', phase: 'DRAFT' } : null;
});

async function load() {
  try {
    data.value = await $fetch<any>('/api/duel/list');
    listError.value = '';
  } catch (e: any) {
    listError.value = e?.data?.statusMessage || e?.message || 'Could not load your duels.';
  } finally {
    loading.value = false;
  }
}

async function respond(duelId: string, accept: boolean) {
  if (responding.value) return;
  responding.value = duelId;
  try {
    const res = await $fetch<any>('/api/duel/respond', { method: 'POST', body: { duelId, accept } });
    if (accept && res.status === 'DRAFTING') return navigateTo(`/duel/${duelId}`);
    await load();
  } catch (e: any) {
    listError.value = e?.data?.statusMessage || e?.message || 'That did not go through.';
    await load();
  } finally {
    responding.value = null;
  }
}

const seconds = computed(() => Math.floor(elapsed.value));

/** The search spinner's four dots, so it reads as activity rather than a frozen screen. */
const pulse = computed(() => Math.floor(elapsed.value * 2) % 4);

onMounted(async () => {
  await Promise.all([restore(), load(), loadRoster()]);
  /**
   * "Queue again" from a result screen lands here with ?battle=1 and goes straight back into
   * the search — unless there is a room to finish, or the five is not ready, in which case
   * the screen says so instead.
   */
  if (route.query.battle === '1' && !liveRoom.value && !missing.value.length && !searching.value) {
    navigateTo('/duels', { replace: true });
    search();
  }
});

watch(searching, (on, was) => { if (on && !was) playSound('searchStart'); });
watch(botOffered, (on) => { if (on) playSound('toggle'); });
useHead({ title: 'Battle — LOM' });
</script>


<template>
  <main class="page battle">
    <header class="topbar">
      <h1>Battle</h1>
      <NuxtLink class="topbar__meta" to="/discovery">Find a manager</NuxtLink>
    </header>

    <p v-if="error" class="notice notice--bad" role="alert">{{ error }}</p>

    <!-- The button. Everything else on this screen is secondary to it. -->
    <section class="arena" :class="{ 'is-searching': searching }">
      <span class="arena__tl" aria-hidden="true" /><span class="arena__br" aria-hidden="true" />

      <template v-if="!searching && liveRoom">
        <p class="arena__lede">
          You are mid-match against <b>{{ liveRoom.opponent }}</b>.
          {{ liveRoom.phase === 'WATCH' ? 'The game is playing out.' : 'The draft is waiting for you: when your clock runs out, the agent plays your turn.' }}
        </p>
        <NuxtLink class="btn btn--lg arena__go" :to="`/duel/${liveRoom.id}`">Rejoin</NuxtLink>
        <p class="arena__sub">One room at a time. Finish this one to start another; challenges and history are below.</p>
      </template>

      <template v-else-if="!searching && missing.length">
        <p class="arena__lede">
          Your five is not ready: no {{ missing.map((r) => ROLE_NAME[r]).join(', ') }}.
          Every lane needs a card before you can draft.
        </p>
        <NuxtLink class="btn btn--lg arena__go" to="/roster">Set your five</NuxtLink>
        <p class="arena__sub">
          No card for a lane? <NuxtLink to="/shop">A Signing pack</NuxtLink> has one for every lane.
        </p>
      </template>

      <template v-else-if="!searching">
        <p class="arena__lede">Draft against another manager, live, then watch the match play out together.</p>
        <button class="btn btn--lg arena__go" type="button" :disabled="busy" @click="search">
          {{ busy ? 'Starting' : 'Battle' }}
        </button>
        <p class="arena__sub">
          <template v-if="waiting"><b class="tnum">{{ waiting }}</b> searching right now</template>
          <template v-else>Ban, pick and play, start to finish. About ten minutes.</template>
        </p>

        <!-- Practice: the agent, now, at the difficulty you pick. Never counts. -->
        <div class="practice">
          <p class="practice__t">Practice vs the agent <span class="faint">· never counts anywhere</span></p>
          <div class="practice__row">
            <div class="seg practice__seg" role="group" aria-label="Agent difficulty">
              <button
                v-for="d in DIFFICULTIES" :key="d" type="button"
                :aria-pressed="difficulty === d" @click="difficulty = d"
              >{{ DIFFICULTY_LABEL[d] }}</button>
            </div>
            <button class="btn btn--ghost practice__go" type="button" :disabled="busy" @click="practice">Practice</button>
          </div>
        </div>
      </template>

      <template v-else>
        <p class="arena__state"><i aria-hidden="true" />Searching</p>
        <p class="arena__clock num" aria-live="off">{{ Math.floor(seconds / 60) }}:{{ String(seconds % 60).padStart(2, '0') }}</p>
        <p class="arena__hunt" aria-hidden="true">
          <span v-for="n in 4" :key="n" :class="{ 'is-on': pulse === n - 1 }" />
        </p>
        <p class="arena__note" aria-live="polite">
          <template v-if="waiting">
            {{ waiting }} other {{ waiting === 1 ? 'manager is' : 'managers are' }} searching. Pairing you now.
          </template>
          <template v-else>Nobody else is searching yet. You go in the moment somebody does.</template>
        </p>

        <!-- The search carries on underneath this. A human who turns up still wins. -->
        <div v-if="botOffered" class="arena__bot">
          <p>Rather not wait?</p>
          <button class="btn btn--ghost btn--block" type="button" :disabled="busy" @click="playBot">
            Draft against the agent
          </button>
        </div>
        <button class="btn btn--quiet arena__cancel" type="button" @click="cancel">Stop searching</button>
      </template>
    </section>

    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <div v-if="loading" class="skeleton battle__skeleton" />

    <template v-else-if="data">
      <!-- The record. Battles first; everything else apart. -->
      <section v-if="battles.played || otherRecords.length" class="record" aria-label="Your record">
        <div class="record__main">
          <p class="label">Battles</p>
          <p class="record__wl tnum">
            <b>{{ battles.wins }}</b>W <b>{{ battles.losses }}</b>L
          </p>
          <p v-if="battles.streak > 1" class="record__streak">{{ battles.streak }} {{ battles.streakWon ? 'wins' : 'losses' }} in a row</p>
          <p v-else-if="!battles.played" class="record__streak faint">No queue games yet</p>
        </div>
        <ul v-if="otherRecords.length" class="record__rest">
          <li v-for="r in otherRecords" :key="r.label"><span>{{ r.label }}</span> <b class="tnum">{{ r.wins }}–{{ r.losses }}</b></li>
        </ul>
      </section>

      <!-- Being put back into a live room beats everything else on this page. -->
      <section v-if="data.live?.length > 1" class="block">
        <h2 class="sect">You are in a room</h2>
        <ul class="rows">
          <li v-for="d in data.live" :key="d.id" class="row">
            <span class="row__mark row__mark--live" aria-hidden="true" />
            <p class="row__t">
              vs {{ d.opponent }}
              <span class="row__s">
                <template v-if="d.phase === 'WATCH'">Watching the match</template>
                <template v-else>{{ d.side === 'BLUE' ? 'Blue' : 'Red' }} side · step {{ Math.min(d.turn + 1, 20) }} of 20</template>
              </span>
            </p>
            <NuxtLink class="btn btn--ghost btn--sm" :to="`/duel/${d.id}`">Rejoin</NuxtLink>
          </li>
        </ul>
      </section>

      <section v-if="data.incoming.length" class="block">
        <h2 class="sect">Friendlies waiting on you</h2>
        <ul class="rows">
          <li v-for="d in data.incoming" :key="d.id" class="row">
            <span class="row__mark" aria-hidden="true">{{ (d.opponent || '?').slice(0, 2) }}</span>
            <p class="row__t">{{ d.opponent }} challenged you<span class="row__s">A friendly: it does not count anywhere<template v-if="d.createdAt"> · {{ ago(d.createdAt) }}</template> · expires after a day</span></p>
            <span class="row__acts">
              <button
                class="btn btn--quiet btn--sm" type="button"
                :disabled="responding === d.id" @click="respond(d.id, false)"
              >Decline</button>
              <button
                class="btn btn--ghost btn--sm" type="button"
                :disabled="responding === d.id" @click="respond(d.id, true)"
              >{{ responding === d.id ? 'Starting' : 'Accept' }}</button>
            </span>
          </li>
        </ul>
      </section>

      <section v-if="data.outgoing.length" class="block">
        <h2 class="sect">Waiting on them</h2>
        <ul class="rows">
          <li v-for="d in data.outgoing" :key="d.id" class="row">
            <span class="row__mark" aria-hidden="true">{{ (d.opponent || '?').slice(0, 2) }}</span>
            <p class="row__t">You challenged {{ d.opponent }}<span class="row__s">It starts when they accept</span></p>
            <button
              class="btn btn--quiet btn--sm" type="button"
              :disabled="responding === d.id" @click="respond(d.id, false)"
            >Withdraw</button>
          </li>
        </ul>
      </section>

      <!-- People you have played, with the head-to-head, one tap from a rematch. -->
      <section v-if="opponents.length" class="block">
        <h2 class="sect">Recent opponents</h2>
        <ul class="rows">
          <li v-for="o in opponents" :key="o.id" class="row">
            <span class="row__mark" aria-hidden="true">{{ (o.name || '?').slice(0, 2) }}</span>
            <p class="row__t">
              {{ o.name }}
              <span class="row__s">Head to head <b class="tnum">{{ o.wins }}–{{ o.losses }}</b> · last {{ ago(o.lastPlayedAt) }}</span>
            </p>
            <button
              class="btn btn--ghost btn--sm" type="button"
              :disabled="challenging === o.id" @click="challenge(o.id, o.name)"
            >{{ challenging === o.id ? 'Sending' : 'Challenge' }}</button>
          </li>
        </ul>
      </section>

      <section v-if="data.finished.length" class="block">
        <h2 class="sect">Played</h2>
        <ul class="rows">
          <li v-for="d in data.finished" :key="d.id" class="row">
            <span class="tag played__tag" :class="d.won ? 'tag--new' : d.won === false ? 'tag--red' : ''">{{ d.won ? 'Won' : d.won === false ? 'Lost' : 'Over' }}</span>
            <p class="row__t">
              vs {{ d.opponent }}<template v-if="d.isBot && d.difficulty"> ({{ difficultyLabel(d.difficulty) }})</template>
              <span class="row__s">
                <template v-if="d.score"><b class="tnum">{{ d.score.mine }}–{{ d.score.theirs }}</b> · </template>
                <template v-if="d.gameLength"><span class="tnum">{{ mmss(d.gameLength) }}</span> · </template>
                {{ SOURCE_NAME[d.source] || 'Friendly' }}<template v-if="d.h2h"> · H2H <span class="tnum">{{ d.h2h.wins }}–{{ d.h2h.losses }}</span></template><template v-if="d.completedAt || d.createdAt"> · {{ ago(d.completedAt || d.createdAt) }}</template>
              </span>
            </p>
            <span class="row__acts">
              <button
                v-if="d.opponentId" class="btn btn--quiet btn--sm" type="button"
                :disabled="challenging === d.opponentId" @click="challenge(d.opponentId, d.opponent)"
              >Challenge</button>
              <NuxtLink class="btn btn--quiet btn--sm" :to="`/duel/${d.id}`">Watch</NuxtLink>
            </span>
          </li>
        </ul>
      </section>

      <p
        v-if="!data.live?.length && !data.incoming.length && !data.outgoing.length && !data.finished.length"
        class="faint battle__none"
      >
        Nothing played yet. Press Battle, or challenge someone you know from
        <NuxtLink to="/discovery">Find a manager</NuxtLink> or your league.
      </p>
    </template>
  </main>
</template>

<style scoped>
.battle__skeleton { height: 160px; margin-top: 20px; }

/* Practice: under the one teal button, quieter than it. */
.practice { display: grid; gap: 8px; width: min(100%, 360px); margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line-1); }
.practice__t { margin: 0; font-size: 13px; font-weight: 650; color: var(--ink-2); }
.practice__t span { font-weight: 500; }
.practice__row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
@media (max-width: 420px) { .practice__row { grid-template-columns: 1fr; } .practice__seg { display: grid; grid-template-columns: repeat(3, 1fr); } }
.practice__seg button { min-height: 44px; }
.practice__go { min-height: 44px; }

/* The record: Battles big, the rest small and apart. */
.record { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 10px 20px; margin-top: 20px; padding: 14px 16px; border: 1px solid var(--line-1); border-radius: var(--radius); background: var(--bg-1); }
.record__main { display: grid; gap: 2px; }
.record__main .label { margin: 0; }
.record__wl { margin: 0; font-stretch: 75%; font-size: 34px; font-weight: 800; line-height: 1; color: var(--ink-2); }
.record__wl b { color: var(--ink-1); }
.record__streak { margin: 2px 0 0; font-size: 12.5px; color: var(--ink-2); }
.record__rest { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12.5px; color: var(--ink-3); }
.record__rest b { color: var(--ink-2); }

.played__tag { min-width: 52px; justify-content: center; }
.row__s b { color: var(--ink-1); font-weight: 800; }

.arena {
  position: relative;
  display: grid;
  justify-items: center;
  gap: 12px;
  padding: 36px 20px 30px;
  text-align: center;
  background:
    linear-gradient(100deg, rgba(74, 144, 255, 0.1), transparent 38%, transparent 62%, rgba(240, 80, 95, 0.1)),
    linear-gradient(165deg, #121b2d, #0a0f19 70%);
  border: 1px solid var(--line-1);
  border-radius: var(--radius);
}
.arena__tl, .arena__br { position: absolute; width: 14px; height: 14px; border: 1.5px solid var(--gold-2); pointer-events: none; }
.arena__tl { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
.arena__br { right: -1px; bottom: -1px; border-left: 0; border-top: 0; }

.arena__lede { margin: 0; max-width: 32ch; font-size: 15px; color: var(--ink-2); }
.arena__go { width: min(100%, 340px); min-height: 64px; font-size: 18px; letter-spacing: 0.2em; margin-top: 8px; --c: 14px; }
.arena__sub { margin: 0; font-size: 12.5px; color: var(--ink-3); }
.arena__sub b { color: var(--teal-1); }

.arena__state { display: inline-flex; align-items: center; gap: 8px; margin: 0; font-size: 13px; font-weight: 650; color: var(--teal-1); }
.arena__state i { width: 7px; height: 7px; background: var(--teal-2); transform: rotate(45deg); }
.arena__clock { margin: 0; font-size: 64px; }
.arena__hunt { display: flex; gap: 10px; margin: 0; }
.arena__hunt span { width: 9px; height: 9px; transform: rotate(45deg); background: var(--bg-4); transition: background 0.2s ease; }
.arena__hunt span.is-on { background: var(--teal-2); }
.arena__note { margin: 4px 0 0; max-width: 34ch; font-size: 13.5px; color: var(--ink-2); }
.arena__bot { display: grid; gap: 8px; width: min(100%, 320px); margin-top: 10px; padding-top: 14px; border-top: 1px solid var(--line-1); }
.arena__bot p { margin: 0; font-size: 13px; color: var(--ink-3); }
.arena__cancel { margin-top: 4px; }

.sect { margin: 0 0 10px; font-stretch: 92%; font-weight: 720; font-size: 17px; }

.rows { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line-1); }
.row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 11px 0; border-bottom: 1px solid var(--line-1); }
.row__mark {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: linear-gradient(135deg, #1d2a44, #0d1422);
  box-shadow: inset 0 0 0 1px var(--line-3);
  font-size: 13px;
  font-weight: 760;
  text-transform: uppercase;
}
.row__mark--live { background: var(--teal-2); box-shadow: none; }
.row__t { margin: 0; font-size: 14.5px; font-weight: 620; line-height: 1.25; min-width: 0; }
.row__s { display: block; margin-top: 3px; font-size: 12.5px; font-weight: 500; color: var(--ink-3); }
.row__acts { display: flex; gap: 6px; }
@media (max-width: 520px) {
  .row:has(.row__acts) { grid-template-columns: auto minmax(0, 1fr); }
  .row__acts { grid-column: 2; }
}

.battle__none { margin-top: 24px; font-size: 14px; }

@media (prefers-reduced-motion: reduce) {
  .arena__hunt span { transition: none; }
}
</style>
