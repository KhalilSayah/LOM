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

    <div role="alert" aria-live="assertive"><p v-if="error" class="notice notice--bad">{{ error }}</p></div>
    <div role="status" aria-live="polite"><p v-if="!error && note" class="notice notice--live">{{ note }}</p></div>

    <div v-if="loading" class="skeleton spon__skeleton" />

    <template v-else>
      <!-- what the meeting produced -->
      <section v-if="pulled" class="pulled" aria-live="polite">
        <span class="corner corner--tl" aria-hidden="true" /><span class="corner corner--br" aria-hidden="true" />
        <template v-if="pulled.sponsor && !pulled.duplicate">
          <p class="label tierline"><i class="gem" :class="`gem--${pulled.sponsor.tier.toLowerCase()}`" aria-hidden="true" />New contract · {{ TIER_LABEL[pulled.sponsor.tier] }}</p>
          <h2 class="pulled__name">{{ pulled.sponsor.name }}</h2>
          <p class="pulled__demand">{{ pulled.sponsor.demandLabel }}</p>
          <p class="pulled__money tnum">
            {{ pulled.sponsor.basePayout }} a match, {{ pulled.sponsor.bonusPayout }} more when they get it
          </p>
        </template>
        <template v-else>
          <p class="label tierline"><i class="gem" :class="`gem--${pulled.tier.toLowerCase()}`" aria-hidden="true" />{{ TIER_LABEL[pulled.tier] }} meeting</p>
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
              <span class="corner corner--tl" aria-hidden="true" /><span class="corner corner--br" aria-hidden="true" />
              <header class="slot__top">
                <div>
                  <p class="label tierline"><i class="gem" :class="`gem--${slot.tier.toLowerCase()}`" aria-hidden="true" />Slot {{ i + 1 }} · {{ TIER_LABEL[slot.tier] }}</p>
                  <h2 class="slot__name"><i class="brandmark" aria-hidden="true" />{{ slot.name }}</h2>
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
          <span class="corner corner--tl" aria-hidden="true" /><span class="corner corner--br" aria-hidden="true" />
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
              <p class="label tierline"><i class="gem" :class="`gem--${s.tier.toLowerCase()}`" aria-hidden="true" />{{ TIER_LABEL[s.tier] }}</p>
              <h3 class="deal__name"><i class="brandmark" aria-hidden="true" />{{ s.name }}</h3>
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
              <p class="label tierline"><i class="gem" :class="`gem--${s.tier.toLowerCase()}`" aria-hidden="true" />{{ TIER_LABEL[s.tier] }}</p>
              <h3 class="deal__name"><i class="brandmark" aria-hidden="true" />{{ s.name }}</h3>
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
/* Broadcast Night pass: tokens instead of raw whites, no stripe accents (a brand shows as a
   small mark beside its name), tier always as gem + word, gold corners on what you hold. */
.spon__skeleton { height: 40vh; }

.corner { position: absolute; width: 12px; height: 12px; border: 1.5px solid var(--gold-2); pointer-events: none; }
.corner--tl { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
.corner--br { right: -1px; bottom: -1px; border-left: 0; border-top: 0; }

.tierline { display: flex; align-items: center; gap: 7px; margin: 0; }
.tierline .gem { width: 10px; height: 10px; }

/* The brand's own colour, as a mark rather than a stripe. */
.brandmark {
  display: inline-block;
  flex: none;
  width: 10px;
  height: 10px;
  margin-right: 9px;
  vertical-align: 0.1em;
  transform: rotate(45deg);
  background: var(--accent);
}

.slots { display: grid; gap: 12px; margin-bottom: 16px; }

.slot {
  --accent: var(--gold-2);
  position: relative;
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--line-2);
  border-radius: var(--radius);
  background: linear-gradient(165deg, #121b2d, #0a0f19 75%);
}
.slot.is-empty {
  align-content: center;
  min-height: 120px;
  border: 1px dashed var(--line-2);
  background: transparent;
}
.slot__top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.slot__name { margin: 4px 0 0; font-size: 22px; overflow-wrap: anywhere; }
.slot__ceiling { display: inline-flex; align-items: center; gap: 5px; flex: none; color: var(--gold-1); font-weight: 760; font-size: 15px; }
.slot__demand {
  margin: 0;
  padding: 10px 12px;
  border-radius: 2px;
  background: var(--bg-0);
  box-shadow: inset 0 0 0 1px var(--line-1);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}
.slot__free { margin: 6px 0 0; color: var(--ink-2); font-size: 13.5px; }
.slot .btn { justify-self: start; }

.terms { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 0; }
.terms div { min-width: 0; }
.terms dt { color: var(--ink-3); font-size: 12px; font-weight: 600; }
.terms dd { margin: 2px 0 0; font-weight: 760; font-size: 17px; font-stretch: 85%; }

.slot__term { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; color: var(--ink-2); font-size: 12.5px; }
.pips { display: inline-flex; gap: 3px; }
.pips i { width: 16px; height: 4px; border-radius: 2px; background: var(--bg-4); }
.pips i.is-on { background: var(--gold-2); }

.meet {
  position: relative;
  display: grid;
  gap: 14px;
  padding: 16px;
  margin-bottom: 24px;
  border: 1px solid rgba(216, 176, 100, 0.3);
  border-radius: var(--radius);
  background: rgba(216, 176, 100, 0.05);
}
.meet__name { margin: 0; font-size: 19px; }
.meet__blurb { margin: 4px 0 0; color: var(--ink-2); font-size: 13.5px; line-height: 1.5; max-width: 46ch; }
.meet .btn { width: 100%; }

.shelf { margin-bottom: 24px; }
.shelf__head { margin: 0 0 4px; font-stretch: 92%; font-weight: 720; font-size: 17px; }
.shelf__note { margin: 0 0 12px; font-size: 12.5px; }

.deck { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }

.deal {
  --accent: var(--ink-4);
  display: grid;
  gap: 6px;
  align-content: start;
  padding: 14px;
  border: 1px solid var(--line-1);
  border-radius: var(--radius);
  background: var(--bg-2);
}
.deal.is-locked { background: transparent; }
.deal.is-locked .deal__name, .deal.is-locked .deal__demand { color: var(--ink-2); }
.deal__name { margin: 2px 0 0; font-size: 17px; overflow-wrap: anywhere; }
.deal__demand { margin: 0; font-size: 13.5px; line-height: 1.45; }
.deal__money { margin: 0; color: var(--gold-1); font-size: 13px; font-weight: 680; }
.deal.is-locked .deal__money { color: var(--ink-3); }
.deal__blurb { margin: 0; color: var(--ink-3); font-size: 12.5px; line-height: 1.5; }
.deal .btn { justify-self: start; margin-top: 6px; }

.pulled {
  position: relative;
  display: grid;
  justify-items: center;
  padding: 28px 18px 22px;
  border: 1px solid rgba(216, 176, 100, 0.34);
  border-radius: var(--radius);
  background: linear-gradient(165deg, #121b2d, #0a0f19 70%);
  text-align: center;
}
.pulled .tierline { justify-content: center; }
.pulled__name { margin: 8px 0; font-size: clamp(24px, 7vw, 32px); }
.pulled__demand { margin: 0 auto 10px; max-width: 44ch; font-size: 14px; line-height: 1.5; }
.pulled__money { margin: 0 0 18px; color: var(--gold-1); font-size: 13.5px; font-weight: 680; }

.spon__foot { margin: 4px 0 0; font-size: 12.5px; line-height: 1.55; }

@media (min-width: 560px) {
  .meet { grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
  .meet .btn { width: auto; }
}
@media (min-width: 720px) {
  .slots { grid-template-columns: 1fr 1fr; }
  .deck { grid-template-columns: 1fr 1fr; }
}
@media (min-width: 1024px) {
  .deck { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
</style>
