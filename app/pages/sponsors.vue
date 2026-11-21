<script setup lang="ts">
/**
 * Sponsors.
 *
 * Two slots, a drawer of contracts you hold, and the rest of the book greyed out. Every
 * card leads with the demand rather than the money, because the demand is the decision:
 * the appearance fee is the same whatever you field, and the bonus is the reason to build
 * one way instead of another.
 *
 * The terms of a contract you do not own are shown in full. A sponsor meeting costs 600
 * Credits, and deciding whether that is worth it means knowing what is in the deck — the
 * same argument the shop makes for publishing its drop odds.
 */

interface Sponsor {
  key: string;
  name: string;
  blurb: string | null;
  tier: string;
  signingBonus: number;
  basePayout: number;
  bonusPayout: number;
  demandLabel: string;
  accent: string | null;
  owned: boolean;
  signed: boolean;
  slot: number | null;
  creditsEarned: number;
  matchesPaid: number;
  term: number;
  matchesIntoTerm: number;
  termServed: boolean;
  buyout: number;
}

interface Book {
  credits: number;
  slots: (Sponsor | null)[];
  slotCount: number;
  sponsors: Sponsor[];
  drawer: Sponsor[];
  pack: { name: string; blurb: string; price: number };
}

useHead({ title: 'Sponsors — LOM' });

const { credits: wallet } = useWallet();

const book = ref<Book | null>(null);
const loading = ref(true);
const busy = ref<string | null>(null);
const error = ref('');
const note = ref('');
const pulled = ref<null | { sponsor: Sponsor | null; duplicate: boolean; creditsEarned: number; tier: string }>(null);

const TIER_LABEL: Record<string, string> = {
  COMMON: 'Common', RARE: 'Rare', EPIC: 'Epic', LEGENDARY: 'Legendary', ICON: 'Icon',
};

const locked = computed(() => (book.value?.sponsors || []).filter((s) => !s.owned));
const signedCount = computed(() => (book.value?.slots || []).filter(Boolean).length);

/** What a contract is worth at best, which is the number worth comparing brands on. */
const ceiling = (s: Sponsor) => s.basePayout + s.bonusPayout;

function apply(next: Book) {
  book.value = next;
  wallet.value = next.credits;
}

async function load() {
  try {
    apply(await $fetch<Book>('/api/sponsors'));
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'Could not load the sponsor book.';
  } finally {
    loading.value = false;
  }
}

async function act(key: string, path: string, body: Record<string, unknown>, said: (r: any) => string) {
  if (busy.value) return;
  busy.value = key;
  error.value = '';
  note.value = '';
  try {
    const res = await $fetch<any>(path, { method: 'POST', body });
    apply(res);
    note.value = said(res);
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'That did not go through.';
  } finally {
    busy.value = null;
  }
}

const sign = (s: Sponsor, slot?: number) => act(
  s.key, '/api/sponsors/sign', { sponsorKey: s.key, slot },
  (r) => r.signingBonus
    ? `${r.name} signed. Signing bonus: ${r.signingBonus} credits.`
    : `${r.name} signed.`,
);

/**
 * Releasing asks twice when the term is unserved, because the second tap is a purchase.
 * The server refuses an unconfirmed buy-out as well — the price is never charged by a tap
 * that did not say it was paying.
 */
const confirming = ref<string | null>(null);

function release(s: Sponsor) {
  if (!s.termServed && confirming.value !== s.key) {
    confirming.value = s.key;
    return;
  }
  confirming.value = null;
  return act(
    s.key, '/api/sponsors/release', { sponsorKey: s.key, buyout: !s.termServed },
    (r) => r.buyoutPaid
      ? `${r.name} bought out for ${r.buyoutPaid} credits.`
      : `${r.name} released.`,
  );
}

async function meet() {
  if (busy.value) return;
  busy.value = 'PACK';
  error.value = '';
  note.value = '';
  try {
    const res = await $fetch<any>('/api/sponsors/pack', { method: 'POST' });
    apply(res);
    pulled.value = { sponsor: res.sponsor, duplicate: res.duplicate, creditsEarned: res.creditsEarned, tier: res.tier };
    playSound(res.duplicate ? 'coin' : 'cardFlip');
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'The meeting did not happen.';
  } finally {
    busy.value = null;
  }
}

const canAfford = computed(() => (book.value?.credits ?? 0) >= (book.value?.pack.price ?? 0));

onMounted(load);
</script>

<template>
  <main class="page page--wide spon">
    <header class="topbar">
      <h1>Sponsors</h1>
      <span class="topbar__meta">{{ signedCount }} of {{ book?.slotCount ?? 2 }} slots signed</span>
    </header>

    <p v-if="error" class="notice notice--bad">{{ error }}</p>
    <p v-else-if="note" class="notice">{{ note }}</p>

    <div v-if="loading" class="skeleton spon__skeleton" />

    <template v-else>
      <!-- what the meeting produced -->
      <section v-if="pulled" class="pulled">
        <template v-if="pulled.sponsor && !pulled.duplicate">
          <p class="label">New contract · {{ TIER_LABEL[pulled.sponsor.tier] }}</p>
          <h2 class="pulled__name">{{ pulled.sponsor.name }}</h2>
          <p class="pulled__demand">{{ pulled.sponsor.demandLabel }}</p>
          <p class="pulled__money tnum">
            {{ pulled.sponsor.basePayout }} a match, {{ pulled.sponsor.bonusPayout }} more when they get it
          </p>
        </template>
        <template v-else>
          <p class="label">{{ TIER_LABEL[pulled.tier] }} meeting</p>
          <h2 class="pulled__name">Nothing new on the table</h2>
          <p class="pulled__demand">
            <template v-if="pulled.sponsor">You already hold {{ pulled.sponsor.name }}.</template>
            <template v-else>You hold every contract in the book.</template>
            They paid <strong>{{ pulled.creditsEarned }} credits</strong> for your time.
          </p>
        </template>
        <button class="btn btn--ghost" type="button" @click="pulled = null">Back to the book</button>
      </section>

      <template v-else>
        <!-- the slots -->
        <section class="slots">
          <article
            v-for="(slot, i) in book?.slots || []" :key="i"
            class="slot" :class="{ 'is-empty': !slot }"
            :style="slot?.accent ? { '--accent': slot.accent } : undefined"
          >
            <template v-if="slot">
              <header class="slot__top">
                <div>
                  <p class="label">Slot {{ i + 1 }} · {{ TIER_LABEL[slot.tier] }}</p>
                  <h2 class="slot__name">{{ slot.name }}</h2>
                </div>
                <span class="slot__ceiling tnum"><i class="coin coin--s" aria-hidden="true" />{{ ceiling(slot) }}</span>
              </header>

              <p class="slot__demand">{{ slot.demandLabel }}</p>

              <dl class="terms">
                <div><dt>Every match</dt><dd class="tnum">{{ slot.basePayout }}</dd></div>
                <div><dt>Terms met</dt><dd class="tnum">+{{ slot.bonusPayout }}</dd></div>
                <div><dt>Earned so far</dt><dd class="tnum">{{ slot.creditsEarned.toLocaleString('en') }}</dd></div>
              </dl>

              <p class="slot__term">
                <span class="pips" aria-hidden="true">
                  <i v-for="n in slot.term" :key="n" :class="{ 'is-on': n <= slot.matchesIntoTerm }" />
                </span>
                <template v-if="slot.termServed">Term served — release is free.</template>
                <template v-else>
                  {{ slot.term - slot.matchesIntoTerm }} more
                  {{ slot.term - slot.matchesIntoTerm === 1 ? 'match' : 'matches' }} on the term
                </template>
              </p>

              <button
                class="btn btn--ghost btn--sm"
                type="button"
                :disabled="busy !== null"
                @click="release(slot)"
              >
                <template v-if="busy === slot.key">Releasing</template>
                <template v-else-if="slot.termServed">Release</template>
                <template v-else-if="confirming === slot.key">Pay {{ slot.buyout }} and tear it up</template>
                <template v-else>Buy out · {{ slot.buyout }}</template>
              </button>
            </template>

            <template v-else>
              <p class="label">Slot {{ i + 1 }}</p>
              <p class="slot__free">Empty. A signed contract pays on every match you play.</p>
            </template>
          </article>
        </section>

        <!-- the meeting -->
        <section v-if="book" class="meet">
          <div>
            <h2 class="meet__name">{{ book?.pack.name }}</h2>
            <p class="meet__blurb">{{ book?.pack.blurb }}</p>
          </div>
          <button
            class="btn btn--gold" data-sound="coin" type="button"
            :class="{ 'btn--off': !canAfford }"
            :disabled="!canAfford || busy !== null"
            @click="meet"
          >
            <template v-if="busy === 'PACK'">Meeting</template>
            <template v-else-if="!canAfford">Need {{ ((book?.pack.price ?? 0) - (book?.credits ?? 0)).toLocaleString('en') }} more</template>
            <template v-else>Take a meeting · {{ book?.pack.price.toLocaleString('en') }}</template>
          </button>
        </section>

        <!-- held but unsigned -->
        <section v-if="book?.drawer.length" class="shelf">
          <h2 class="shelf__head">In the drawer</h2>
          <ul class="deck">
            <li v-for="s in book.drawer" :key="s.key" class="deal" :style="s.accent ? { '--accent': s.accent } : undefined">
              <p class="label">{{ TIER_LABEL[s.tier] }}</p>
              <h3 class="deal__name">{{ s.name }}</h3>
              <p class="deal__demand">{{ s.demandLabel }}</p>
              <p class="deal__money tnum">{{ s.basePayout }} + {{ s.bonusPayout }} a match</p>
              <button
                class="btn btn--sm"
                type="button"
                :disabled="busy !== null || signedCount >= (book?.slotCount ?? 2)"
                @click="sign(s)"
              >
                <template v-if="busy === s.key">Signing</template>
                <template v-else-if="signedCount >= (book?.slotCount ?? 2)">Slots full</template>
                <template v-else>Sign</template>
              </button>
            </li>
          </ul>
        </section>

        <!-- the rest of the book -->
        <section v-if="locked.length" class="shelf">
          <h2 class="shelf__head">Out there</h2>
          <p class="shelf__note faint">
            Contracts you have not met yet. A meeting draws one you do not already hold.
          </p>
          <ul class="deck">
            <li v-for="s in locked" :key="s.key" class="deal is-locked">
              <p class="label">{{ TIER_LABEL[s.tier] }}</p>
              <h3 class="deal__name">{{ s.name }}</h3>
              <p class="deal__demand">{{ s.demandLabel }}</p>
              <p class="deal__money tnum">{{ s.basePayout }} + {{ s.bonusPayout }} a match</p>
              <p v-if="s.blurb" class="deal__blurb">{{ s.blurb }}</p>
            </li>
          </ul>
        </section>

        <p class="spon__foot faint">
          A sponsor pays its appearance fee for every match you play, and the bonus only when
          the five you fielded met its terms. A Ghost match pays sponsors at half rate, like
          everything else it pays.
        </p>
      </template>
    </template>
  </main>
</template>

<style scoped>
.spon__skeleton { height: 40vh; }

.slots {
  display: grid;
  gap: 12px;
  margin-bottom: 16px;
}

.slot {
  --accent: var(--gold, #d8b064);
  position: relative;
  padding: 14px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius);
  background: var(--bg-2);
}
.slot.is-empty {
  border-left-color: rgba(255, 255, 255, 0.12);
  border-style: dashed;
  background: transparent;
}
.slot__top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.slot__name { margin: 2px 0 0; font-size: 18px; }
.slot__ceiling { display: inline-flex; align-items: center; gap: 4px; font-weight: 680; }
.slot__demand {
  margin: 10px 0 12px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  font-size: 14px;
}
.slot__free { margin: 6px 0 0; color: var(--ink-2); font-size: 13.5px; }

.terms { display: flex; flex-wrap: wrap; gap: 14px; margin: 0 0 12px; }
.terms dt { color: var(--ink-2); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; }
.terms dd { margin: 2px 0 0; font-weight: 680; }

.slot__term { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; color: var(--ink-2); font-size: 12.5px; }
.pips { display: inline-flex; gap: 3px; }
.pips i {
  width: 14px; height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.16);
}
.pips i.is-on { background: var(--accent); }

.meet {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  padding: 14px;
  margin-bottom: 20px;
  border: 1px solid rgba(216, 176, 100, 0.3);
  border-radius: var(--radius);
  background: var(--bg-2);
}
.meet__name { margin: 0; font-size: 17px; }
.meet__blurb { margin: 4px 0 0; color: var(--ink-2); font-size: 13px; max-width: 42ch; }

.shelf { margin-bottom: 22px; }
.shelf__head { margin: 0 0 4px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-2); }
.shelf__note { margin: 0 0 10px; font-size: 12.5px; }

.deck { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }

.deal {
  --accent: rgba(255, 255, 255, 0.2);
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius);
  background: var(--bg-2);
}
.deal.is-locked { opacity: 0.62; }
.deal__name { margin: 2px 0 6px; font-size: 16px; }
.deal__demand { margin: 0 0 6px; font-size: 13.5px; }
.deal__money { margin: 0 0 10px; color: var(--ink-2); font-size: 12.5px; }
.deal__blurb { margin: 0; color: var(--ink-2); font-size: 12.5px; }

.pulled {
  padding: 22px 16px;
  border: 1px solid rgba(216, 176, 100, 0.34);
  border-radius: var(--radius);
  background: var(--bg-2);
  text-align: center;
}
.pulled__name { margin: 6px 0 8px; font-size: 22px; }
.pulled__demand { margin: 0 auto 10px; max-width: 44ch; font-size: 14px; }
.pulled__money { margin: 0 0 16px; color: var(--ink-2); font-size: 13px; }

.spon__foot { margin: 4px 0 0; font-size: 12.5px; }

@media (min-width: 720px) {
  .slots { grid-template-columns: 1fr 1fr; }
  .deck { grid-template-columns: 1fr 1fr; }
}
</style>
