<script setup lang="ts">
/**
 * The wallet: the balance, every Credit in and out, and every pack opened.
 *
 * The ledger is the truth behind the number in the brand bar (migration 0004), so this is
 * the screen that answers "where did that come from" and "where did it go" with the
 * receipts themselves.
 */

type Kind = 'MATCH' | 'DUPLICATE' | 'SPONSOR' | 'QUEST' | 'PACK' | 'SEASON' | 'OTHER';

interface Entry {
  id: number;
  delta: number;
  balance: number;
  at: string;
  kind: Kind;
  label: string;
  duelId: string | null;
  openingId: string | null;
}

interface Ledger {
  credits: number;
  entries: Entry[];
  next: number | null;
  last30: Record<Kind, { in: number; out: number }>;
}

interface Opening {
  id: string;
  packType: string;
  packName: string;
  spent: number;
  at: string;
  source: 'DAILY' | 'GIFT' | 'BUY' | 'FREE';
  earned: number;
  cards: Array<{ slot: number; rarity: string; wasDuplicate: boolean; xpAwarded: number; creditsAwarded: number; card: any }>;
}

useHead({ title: 'Wallet — LOM' });

const { credits } = useWallet();

const tab = ref<'ledger' | 'packs'>('ledger');
const ledger = ref<Ledger | null>(null);
const openings = ref<Opening[]>([]);
const openingsNext = ref<string | null>(null);
const openingsLoaded = ref(false);
const loading = ref(true);
const more = ref(false);
const error = ref('');

async function loadLedger(before?: number) {
  const res = await $fetch<Ledger>('/api/wallet/ledger', { query: before ? { before } : {} });
  if (before && ledger.value) {
    ledger.value = { ...res, entries: [...ledger.value.entries, ...res.entries] };
  } else {
    ledger.value = res;
  }
  credits.value = res.credits;
}

async function loadOpenings(before?: string) {
  const res = await $fetch<{ openings: Opening[]; next: string | null }>('/api/wallet/openings', { query: before ? { before } : {} });
  openings.value = before ? [...openings.value, ...res.openings] : res.openings;
  openingsNext.value = res.next;
  openingsLoaded.value = true;
}

async function loadMore() {
  if (more.value) return;
  more.value = true;
  error.value = '';
  try {
    if (tab.value === 'ledger' && ledger.value?.next) await loadLedger(ledger.value.next);
    if (tab.value === 'packs' && openingsNext.value) await loadOpenings(openingsNext.value);
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'Could not load more.';
  } finally {
    more.value = false;
  }
}

watch(tab, async (t) => {
  if (t === 'packs' && !openingsLoaded.value) {
    try { await loadOpenings(); } catch (e: any) { error.value = e?.data?.statusMessage || e?.message || 'Could not load your packs.'; }
  }
});

onMounted(async () => {
  try {
    await loadLedger();
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'Could not load the wallet.';
  } finally {
    loading.value = false;
  }
});

const SOURCES: Array<{ kind: Kind; label: string }> = [
  { kind: 'MATCH', label: 'Matches' },
  { kind: 'SPONSOR', label: 'Sponsors' },
  { kind: 'QUEST', label: 'Quests' },
  { kind: 'DUPLICATE', label: 'Duplicates' },
  { kind: 'SEASON', label: 'Season prizes' },
  { kind: 'PACK', label: 'Packs bought' },
  { kind: 'OTHER', label: 'Other' },
];

const summary = computed(() => {
  const t = ledger.value?.last30;
  if (!t) return { rows: [], totalIn: 0, totalOut: 0 };
  const rows = SOURCES
    .map((s) => ({ ...s, in: t[s.kind]?.in ?? 0, out: t[s.kind]?.out ?? 0 }))
    .filter((r) => r.in || r.out);
  return {
    rows,
    totalIn: rows.reduce((n, r) => n + r.in, 0),
    totalOut: rows.reduce((n, r) => n + r.out, 0),
  };
});

/** Group the ledger by local calendar day, so a busy evening reads as one block. */
const days = computed(() => {
  const groups: Array<{ key: string; label: string; entries: Entry[] }> = [];
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const keyOf = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  for (const e of ledger.value?.entries ?? []) {
    const d = new Date(e.at);
    const key = keyOf(d);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      const label = key === keyOf(today) ? 'Today' : key === keyOf(yesterday) ? 'Yesterday'
        : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
      group = { key, label, entries: [] };
      groups.push(group);
    }
    group.entries.push(e);
  }
  return groups;
});

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const signed = (n: number) => `${n > 0 ? '+' : '−'}${Math.abs(n).toLocaleString('en')}`;
const SOURCE_LABEL: Record<Opening['source'], string> = { DAILY: 'Daily', GIFT: 'Gift', BUY: 'Bought', FREE: 'Free' };
const BAND_LABEL: Record<string, string> = { COMMON: 'Common', RARE: 'Rare', EPIC: 'Epic', LEGENDARY: 'Legendary', ICON: 'Icon' };
</script>

<template>
  <main class="page page--wide wallet">
    <header class="topbar">
      <h1>Wallet</h1>
      <NuxtLink class="topbar__meta" to="/shop">Shop</NuxtLink>
    </header>

    <p v-if="error" class="notice notice--bad" role="alert">{{ error }}</p>
    <div v-if="loading" class="skeleton wallet__skeleton" />

    <template v-else-if="ledger">
      <section class="balance" aria-label="Balance">
        <div>
          <p class="label">Balance</p>
          <p class="balance__n tnum"><i class="coin" aria-hidden="true" />{{ ledger.credits.toLocaleString('en') }}</p>
        </div>
        <div v-if="summary.rows.length" class="balance__month">
          <p class="label">Last 30 days</p>
          <ul class="flow">
            <li v-for="r in summary.rows" :key="r.kind">
              <span>{{ r.label }}</span>
              <span class="tnum flow__n">
                <b v-if="r.in" class="is-in">{{ signed(r.in) }}</b>
                <b v-if="r.out" class="is-out">{{ signed(-r.out) }}</b>
              </span>
            </li>
          </ul>
        </div>
        <p v-else class="faint balance__empty">
          Nothing in or out yet. Matches, sponsors, quests and duplicate pulls all pay Credits.
        </p>
      </section>

      <div class="seg wallet__seg" role="group" aria-label="Show">
        <button type="button" :aria-pressed="tab === 'ledger'" @click="tab = 'ledger'">Credits</button>
        <button type="button" :aria-pressed="tab === 'packs'" @click="tab = 'packs'">Packs opened</button>
      </div>

      <!-- the ledger -->
      <section v-if="tab === 'ledger'" aria-label="Credit history">
        <p v-if="!ledger.entries.length" class="faint">No Credits have moved yet.</p>
        <div v-for="g in days" :key="g.key" class="day">
          <h2 class="day__h">{{ g.label }}</h2>
          <ul class="rows">
            <li v-for="e in g.entries" :key="e.id" class="row">
              <span class="row__t">
                <NuxtLink v-if="e.duelId" :to="`/duel/${e.duelId}`">{{ e.label }}</NuxtLink>
                <template v-else>{{ e.label }}</template>
                <span class="row__s">{{ time(e.at) }} · balance {{ e.balance.toLocaleString('en') }}</span>
              </span>
              <b class="row__n tnum" :class="e.delta > 0 ? 'is-in' : 'is-out'">{{ signed(e.delta) }}</b>
            </li>
          </ul>
        </div>
        <button v-if="ledger.next" class="btn btn--ghost btn--block" type="button" :disabled="more" @click="loadMore">
          {{ more ? 'Loading' : 'Older' }}
        </button>
      </section>

      <!-- the packs -->
      <section v-else aria-label="Packs opened">
        <div v-if="!openingsLoaded" class="skeleton wallet__skeleton" />
        <p v-else-if="!openings.length" class="faint">No packs opened yet. <NuxtLink to="/pack">Open today's</NuxtLink>.</p>
        <article v-for="o in openings" :key="o.id" class="op">
          <header class="op__top">
            <div>
              <h2 class="op__name">{{ o.packName }}</h2>
              <p class="op__s">{{ SOURCE_LABEL[o.source] }} · {{ when(o.at) }}</p>
            </div>
            <p class="op__money tnum">
              <span v-if="o.spent" class="is-out">{{ signed(-o.spent) }}</span>
              <span v-if="o.earned" class="is-in">{{ signed(o.earned) }}</span>
            </p>
          </header>
          <ul class="op__cards">
            <li v-for="c in o.cards" :key="c.slot" class="op__card">
              <NuxtLink v-if="c.card" :to="`/card/${c.card.cardKey}`" class="op__thumb" :aria-label="`${c.card.playerName} ${c.card.season}`">
                <LomCard :card="c.card" compact :interactive="false" />
              </NuxtLink>
              <p class="op__line">
                <i class="gem" :class="`gem--${c.rarity.toLowerCase()}`" aria-hidden="true" />
                <span>{{ BAND_LABEL[c.rarity] ?? c.rarity }}</span>
              </p>
              <p class="op__line faint">
                <template v-if="c.wasDuplicate">Duplicate<template v-if="c.xpAwarded"> · +{{ c.xpAwarded }} XP</template><template v-if="c.creditsAwarded"> · +{{ c.creditsAwarded }}</template></template>
                <template v-else>New</template>
              </p>
            </li>
          </ul>
        </article>
        <button v-if="openingsNext" class="btn btn--ghost btn--block" type="button" :disabled="more" @click="loadMore">
          {{ more ? 'Loading' : 'Older' }}
        </button>
      </section>
    </template>
  </main>
</template>

<style scoped>
.wallet__skeleton { height: 40vh; }

.balance {
  display: grid;
  gap: 18px;
  padding: 18px;
  margin-bottom: 18px;
  background: var(--bg-2);
  border: 1px solid var(--line-1);
  border-radius: var(--radius);
}
.balance__n { display: inline-flex; align-items: center; gap: 10px; margin: 6px 0 0; font-stretch: 78%; font-weight: 840; font-size: 40px; line-height: 1; color: var(--gold-1); }
.balance__empty { margin: 0; font-size: 13.5px; }
.flow { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 6px; }
.flow li { display: flex; justify-content: space-between; gap: 12px; font-size: 13.5px; color: var(--ink-2); }
.flow__n { display: inline-flex; gap: 10px; }

.is-in { color: var(--gold-1); font-weight: 700; }
.is-out { color: var(--ink-2); font-weight: 700; }

.wallet__seg { margin-bottom: 14px; }

.day { margin-bottom: 18px; }
.day__h { font-size: 13px; font-weight: 650; color: var(--ink-3); margin: 0 0 6px; }
.rows { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line-1); }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 52px; padding: 8px 0; border-bottom: 1px solid var(--line-1); }
.row__t { font-size: 14px; font-weight: 600; line-height: 1.3; min-width: 0; }
.row__t a { color: var(--ink-1); text-decoration: underline; text-decoration-color: var(--line-3); text-underline-offset: 3px; }
.row__s { display: block; margin-top: 2px; font-size: 12px; font-weight: 500; color: var(--ink-3); }
.row__n { font-size: 15px; white-space: nowrap; }

.op { padding: 16px 0; border-bottom: 1px solid var(--line-1); }
.op__top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
.op__name { font-size: 16px; font-weight: 700; }
.op__s { margin: 2px 0 0; font-size: 12.5px; color: var(--ink-3); }
.op__money { margin: 0; display: grid; justify-items: end; font-size: 14px; }
.op__cards { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 10px; }
.op__card { display: grid; gap: 4px; align-content: start; }
.op__thumb { display: block; }
.op__line { margin: 0; display: flex; align-items: center; gap: 5px; font-size: 12px; }
.op__line .gem { width: 9px; height: 9px; }

@media (min-width: 720px) {
  .balance { grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); align-items: start; }
  .op__cards { grid-template-columns: repeat(5, minmax(0, 120px)); }
}
</style>
