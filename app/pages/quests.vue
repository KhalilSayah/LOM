<script setup lang="ts">
/**
 * Quests: three dailies that turn over with the daily pack, three weeklies that turn over
 * on Monday's. Progress comes from the server, which reads it off matches and openings
 * that already happened; this screen only ever asks for it and collects.
 */

interface Quest {
  key: string;
  scope: 'DAILY' | 'WEEKLY';
  title: string;
  detail: string;
  target: number;
  progress: number;
  credits: number;
  done: boolean;
  claimed: boolean;
}

interface Board {
  daily: { periodKey: string; endsAt: string; quests: Quest[] };
  weekly: { periodKey: string; endsAt: string; quests: Quest[] };
  claimable: number;
  dailyDone: number;
  serverNow: string;
}

useHead({ title: 'Quests — LOM' });

const { credits } = useWallet();
const { questsReady } = useQuestSignal();

const board = ref<Board | null>(null);
const loading = ref(true);
const error = ref('');
const collecting = ref<string | null>(null);
const justPaid = ref<{ key: string; paid: number } | null>(null);
let drift = 0;

async function load() {
  try {
    board.value = await $fetch<Board>('/api/quests');
    questsReady.value = board.value.claimable;
    drift = new Date(board.value.serverNow).getTime() - Date.now();
    error.value = '';
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'Could not load quests.';
  } finally {
    loading.value = false;
  }
}

async function collect(q: Quest) {
  if (!q.done || q.claimed || collecting.value) return;
  collecting.value = q.key;
  error.value = '';
  try {
    const res = await $fetch<{ key: string; paid: number; credits: number; claimable: number }>('/api/quests/claim', {
      method: 'POST',
      body: { key: q.key },
    });
    credits.value = res.credits;
    questsReady.value = res.claimable;
    justPaid.value = { key: res.key, paid: res.paid };
    playSound('coin');
    q.claimed = true;
    if (board.value) board.value.claimable = res.claimable;
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'Could not collect that quest.';
    await load();
  } finally {
    collecting.value = null;
  }
}

/** "Resets in 5h 12m", from the server's clock. */
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
function resetsIn(iso: string) {
  const ms = new Date(iso).getTime() - (now.value + drift);
  if (ms <= 0) return 'Resetting now';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 48) return `Resets in ${Math.floor(h / 24)} days`;
  if (h >= 1) return `Resets in ${h}h ${m}m`;
  return `Resets in ${m}m`;
}

/** The board turns over at the roll; re-read it then rather than show stale quests. */
watch(now, () => {
  if (!board.value) return;
  const soonest = Math.min(new Date(board.value.daily.endsAt).getTime(), new Date(board.value.weekly.endsAt).getTime());
  if (now.value + drift > soonest + 2000 && !loading.value) {
    loading.value = true;
    load();
  }
});

onMounted(() => {
  load();
  timer = setInterval(() => { now.value = Date.now(); }, 30000);
});
onBeforeUnmount(() => clearInterval(timer));

const sections = computed(() => board.value
  ? [
      { id: 'daily', title: 'Today', endsAt: board.value.daily.endsAt, quests: board.value.daily.quests },
      { id: 'weekly', title: 'This week', endsAt: board.value.weekly.endsAt, quests: board.value.weekly.quests },
    ]
  : []);
</script>

<template>
  <main class="page page--wide quests">
    <header class="topbar">
      <h1>Quests</h1>
      <span class="topbar__meta">{{ board ? `${board.dailyDone} of ${board.daily.quests.length} dailies done` : '' }}</span>
    </header>

    <p v-if="error" class="notice notice--bad" role="alert">{{ error }}</p>

    <div v-if="loading && !board" class="skeleton quests__skeleton" />

    <template v-else-if="board">
      <section v-for="sec in sections" :key="sec.id" class="qsec" :aria-labelledby="`q-${sec.id}`">
        <div class="qsec__head">
          <h2 :id="`q-${sec.id}`">{{ sec.title }}</h2>
          <span class="faint qsec__reset">{{ resetsIn(sec.endsAt) }}</span>
        </div>

        <ul class="qlist">
          <li v-for="q in sec.quests" :key="q.key" class="quest" :class="{ 'is-done': q.done, 'is-claimed': q.claimed }">
            <div class="quest__body">
              <p class="quest__title">
                <span v-if="q.claimed" class="quest__mark" aria-hidden="true">✓</span>
                {{ q.title }}
              </p>
              <p class="quest__detail">{{ q.detail }}</p>
              <div class="quest__progress">
                <div class="meter" :class="{ 'meter--teal': q.done && !q.claimed }" role="progressbar" :aria-valuemin="0" :aria-valuemax="q.target" :aria-valuenow="q.progress" :aria-label="`${q.progress} of ${q.target}`">
                  <i :style="{ width: `${Math.round((q.progress / q.target) * 100)}%` }" />
                </div>
                <span class="tnum quest__count">{{ q.progress }} / {{ q.target }}</span>
              </div>
            </div>

            <div class="quest__pay">
              <span class="quest__credits tnum"><i class="coin coin--s" aria-hidden="true" />{{ q.credits }}</span>
              <button
                v-if="q.done && !q.claimed"
                class="btn btn--sm"
                type="button"
                data-sound="none"
                :disabled="collecting !== null"
                @click="collect(q)"
              >
                {{ collecting === q.key ? 'Collecting' : 'Collect' }}
              </button>
              <span v-else-if="q.claimed" class="faint quest__state">
                {{ justPaid?.key === q.key ? `+${justPaid.paid} collected` : 'Collected' }}
              </span>
              <span v-else class="faint quest__state">In progress</span>
            </div>
          </li>
        </ul>
      </section>

      <p class="faint quests__foot">
        Progress counts every match you finish, the agent included, and every daily pack you
        open. A quest finished and not collected before it resets goes with it. The quests
        are the same for every manager on the same day.
      </p>
    </template>
  </main>
</template>

<style scoped>
.quests__skeleton { height: 50vh; }

.qsec { margin-bottom: 26px; }
.qsec__head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.qsec__head h2 { font-stretch: 92%; font-weight: 720; font-size: 17px; }
.qsec__reset { font-size: 12.5px; }

.qlist { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line-1); }
.quest {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 16px;
  align-items: center;
  padding: 14px 0;
  border-bottom: 1px solid var(--line-1);
}
.quest__title { margin: 0; font-size: 15px; font-weight: 640; line-height: 1.3; }
.quest__mark { color: var(--gold-1); margin-right: 4px; }
.quest__detail { margin: 3px 0 0; font-size: 12.5px; color: var(--ink-3); }
.quest__progress { display: flex; align-items: center; gap: 10px; margin-top: 10px; max-width: 320px; }
.quest__progress .meter { flex: 1; }
.quest__count { font-size: 12px; color: var(--ink-2); min-width: 40px; text-align: right; }
.quest__pay { display: grid; justify-items: end; gap: 6px; min-width: 96px; }
.quest__credits { display: inline-flex; align-items: center; gap: 6px; font-stretch: 80%; font-weight: 800; font-size: 18px; color: var(--gold-1); }
.quest__state { font-size: 12.5px; min-height: 44px; display: inline-flex; align-items: center; }
.quest.is-claimed .quest__title { color: var(--ink-2); }
.quest.is-claimed .quest__credits { color: var(--ink-3); }

.quests__foot { font-size: 12.5px; max-width: 62ch; }
</style>
