<script setup lang="ts">
/**
 * Odds, pity and every other rule behind a pack, in one place.
 *
 * Everything on this page comes from /api/pack/odds, which reads the same constants and
 * pack_types rows the roll uses, so it cannot disagree with what a pack actually does.
 */

interface PackRow {
  key: string;
  name: string;
  blurb: string | null;
  price: number;
  slots: number;
  one_per_role: boolean;
  weights: Record<string, number>;
  floor_band: string | null;
  max_band: string | null;
  daily_limit: number | null;
}

interface Odds {
  packs: PackRow[];
  pity: { legendary: number; icon: number; iconShareOnLegendaryPity: number };
  roleBias: number;
  duplicate: { xp: number; credits: Record<string, number> };
  daily: { hour: number; timeZone: string; nextOpensAt: string; bankMax: number; streakLength: number; streakFloor: string };
}

useHead({ title: 'Odds — LOM' });

const BANDS = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON'] as const;
const BAND_LABEL: Record<string, string> = { COMMON: 'Common', RARE: 'Rare', EPIC: 'Epic', LEGENDARY: 'Legendary', ICON: 'Icon' };

const { data, error } = await useFetch<Odds>('/api/pack/odds', { server: false });

function pct(pack: PackRow, band: string) {
  const total = BANDS.reduce((n, b) => n + (pack.weights[b] ?? 0), 0) || 1;
  return ((pack.weights[band] ?? 0) / total) * 100;
}
const fmt = (v: number) => (v === 0 ? '—' : v < 1 ? `${v.toFixed(1)}%` : `${Math.round(v * 10) / 10}%`);

const slotsLabel = (p: PackRow) => (p.one_per_role ? `${p.slots}, one per lane` : String(p.slots));

/** The daily hour, in the viewer's own clock as well as the league's. */
const dailyTime = computed(() => {
  const d = data.value?.daily;
  if (!d) return '';
  const local = new Date(d.nextOpensAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  let zone = '';
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* old browser */ }
  const city = (d.timeZone.split('/').pop() || d.timeZone).replaceAll('_', ' ');
  return zone && zone !== d.timeZone
    ? `${local} your time (${String(d.hour).padStart(2, '0')}:00 in ${city})`
    : local;
});
</script>

<template>
  <main class="page page--wide odds">
    <header class="topbar">
      <h1>Odds and pity</h1>
      <NuxtLink class="topbar__meta" to="/shop">Shop</NuxtLink>
    </header>

    <p v-if="error" class="notice notice--bad" role="alert">Could not load the odds. Try again in a moment.</p>
    <div v-else-if="!data" class="skeleton odds__skeleton" />

    <template v-else>
      <section class="osec" aria-labelledby="o-table">
        <h2 id="o-table">Odds per card</h2>
        <p class="osec__lede">
          Each card in a pack is rolled on its own against that pack's table. A pack with a
          floor makes its last card at least that rarity; a pack with a ceiling never rolls
          above it. Pity, below, overrides both.
        </p>
        <div class="otable-wrap">
          <table class="otable">
            <thead>
              <tr>
                <th scope="col">Pack</th>
                <th scope="col" class="tnum">Price</th>
                <th scope="col" class="tnum">Cards</th>
                <th v-for="b in BANDS" :key="b" scope="col" class="tnum">
                  <span class="otable__band"><i class="gem" :class="`gem--${b.toLowerCase()}`" aria-hidden="true" />{{ BAND_LABEL[b] }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in data.packs" :key="p.key">
                <th scope="row">
                  {{ p.name }}
                  <span v-if="p.floor_band" class="otable__rule">Last card {{ BAND_LABEL[p.floor_band] }} or better</span>
                  <span v-else-if="p.max_band" class="otable__rule">Nothing above {{ BAND_LABEL[p.max_band] }}</span>
                  <span v-if="p.daily_limit && p.key !== 'DAILY'" class="otable__rule">{{ p.daily_limit }} a day</span>
                </th>
                <td class="tnum">{{ p.price ? p.price.toLocaleString('en') : 'Free' }}</td>
                <td class="tnum">{{ slotsLabel(p) }}</td>
                <td v-for="b in BANDS" :key="b" class="tnum">{{ fmt(pct(p, b)) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="osec" aria-labelledby="o-pity">
        <h2 id="o-pity">Pity</h2>
        <ul class="orules">
          <li>
            <b>A Legendary within {{ data.pity.legendary }} cards.</b>
            If {{ data.pity.legendary - 1 }} cards in a row have come out below Legendary, the
            next card is Legendary or better ({{ Math.round(data.pity.iconShareOnLegendaryPity * 100) }}% of the time
            it is an Icon instead). A Legendary or an Icon from any roll resets the count.
          </li>
          <li>
            <b>An Icon within {{ data.pity.icon }} cards.</b>
            If {{ data.pity.icon - 1 }} cards in a row have not been an Icon, the next one is. Only an Icon resets it.
          </li>
          <li>
            <b>It counts cards, not packs,</b> and it is one counter shared by every pack: a
            five-card pack moves it five times, and a gift counts the same as a bought pack.
          </li>
          <li>
            <b>It overrides the pack.</b> A guarantee that has come due pays out in whatever
            you open next, even a pack whose ceiling is lower, and before any floor.
          </li>
          <li>Your counters are on Home and in the Shop, so a dry run always has a known end.</li>
        </ul>
      </section>

      <section class="osec" aria-labelledby="o-who">
        <h2 id="o-who">Which player you get</h2>
        <ul class="orules">
          <li>
            <b>Your thinnest lane first, some of the time.</b>
            {{ Math.round(data.roleBias * 100) }}% of cards (outside packs that already give one per lane)
            are drawn from the role you own the fewest cards in, so nobody stays without a jungler.
          </li>
          <li>
            <b>New cards before repeats.</b> Inside the rarity that was rolled, a card you do not
            own yet is always picked over one you have. You only get a duplicate when you
            already own every card of that rarity (and lane, when it is aimed at one).
          </li>
          <li><b>Never the same player twice in one pack.</b></li>
        </ul>
      </section>

      <section class="osec" aria-labelledby="o-dupe">
        <h2 id="o-dupe">Duplicates</h2>
        <p class="osec__lede">
          A card you already hold never arrives as a second copy. It becomes
          +{{ data.duplicate.xp }} XP on the card you have (nothing past level 10) and Credits by rarity:
        </p>
        <ul class="odupes">
          <li v-for="b in BANDS" :key="b">
            <i class="gem" :class="`gem--${b.toLowerCase()}`" aria-hidden="true" />
            <span>{{ BAND_LABEL[b] }}</span>
            <b class="tnum"><i class="coin coin--s" aria-hidden="true" />{{ data.duplicate.credits[b] ?? 0 }}</b>
          </li>
        </ul>
      </section>

      <section class="osec" aria-labelledby="o-daily">
        <h2 id="o-daily">The daily pack</h2>
        <ul class="orules">
          <li><b>A new one every day at {{ dailyTime }}.</b> The pack day runs from that time to the same time the next day.</li>
          <li>
            <b>Unopened packs keep.</b> Up to {{ data.daily.bankMax }} wait for you: today's and the
            two before it. Come back after a weekend and they open one after another.
          </li>
          <li>
            <b>Streak.</b> Open a daily pack {{ data.daily.streakLength }} days in a row and that day's
            first pack is {{ BAND_LABEL[data.daily.streakFloor] }} or better. Miss a day and the count
            starts again; nothing you already have is lost.
          </li>
        </ul>
      </section>
    </template>
  </main>
</template>

<style scoped>
.odds__skeleton { height: 50vh; }
.osec { margin-bottom: 30px; }
.osec h2 { font-stretch: 92%; font-weight: 720; font-size: 18px; margin-bottom: 8px; }
.osec__lede { margin: 0 0 12px; font-size: 14px; color: var(--ink-2); max-width: 66ch; }

.otable-wrap { overflow-x: auto; margin: 0 -16px; padding: 0 16px; }
.otable { width: 100%; min-width: 620px; border-collapse: collapse; font-size: 13.5px; }
.otable th, .otable td { padding: 10px 8px; border-bottom: 1px solid var(--line-1); text-align: right; vertical-align: top; }
.otable thead th { font-size: 12px; font-weight: 650; color: var(--ink-3); white-space: nowrap; }
.otable th[scope='row'], .otable thead th:first-child { text-align: left; font-weight: 650; }
.otable__band { display: inline-flex; align-items: center; gap: 5px; }
.otable__band .gem { width: 9px; height: 9px; }
.otable__rule { display: block; font-size: 12px; font-weight: 500; color: var(--ink-3); margin-top: 2px; }

.orules { margin: 0; padding: 0 0 0 18px; display: grid; gap: 10px; font-size: 14px; color: var(--ink-2); max-width: 70ch; }
.orules b { color: var(--ink-1); font-weight: 650; }

.odupes { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.odupes li { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: var(--bg-2); border: 1px solid var(--line-1); border-radius: var(--radius); font-size: 13.5px; }
.odupes b { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; color: var(--gold-1); font-weight: 760; }
</style>
