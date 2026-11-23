<script setup lang="ts">
/**
 * How to play: the loop in five steps, then the three ideas that decide matches.
 *
 * Open to signed-out visitors (the door links here), so it must not assume a session:
 * the way back goes to Home when signed in and to the door when not. Short on purpose —
 * each step is one line a player can act on, and the numbers quoted are the real ones
 * from packages/core and shared/roster.ts, not a simplification that will drift.
 */
const user = useSupabaseUser();
const home = computed(() => (user.value ? '/pack' : '/'));

const STEPS = [
  { n: 1, title: 'Open a pack', body: 'One free pack a day, plus the welcome pack waiting for you. Every card is a real pro player in a real season.', to: '/pack', cta: 'Home' },
  { n: 2, title: 'Fill your five', body: 'Top, jungle, mid, bot, support. Your five is what every battle and league match is played with.', to: '/roster', cta: 'Team' },
  { n: 3, title: 'Draft', body: 'Bans and picks against a rival, turn by turn. Put each player on a champion they actually played.', to: '/duels', cta: 'Battle' },
  { n: 4, title: 'Watch it play out', body: 'The match is simulated from the draft and replayed on the map: kills, objectives, the lot.', to: '/duels', cta: 'Battle' },
  { n: 5, title: 'Play a league', body: 'Host or join a private league with friends. One match an evening, a table, playoffs, a champion.', to: '/leagues', cta: 'League' },
] as const;

useHead({ title: 'How to play — LOM' });
useSeoMeta({
  description: 'How LOM works in five steps: open packs, fill your five, draft, watch, play a league.',
  ogTitle: 'How to play LOM',
  ogDescription: 'Open packs, fill your five, draft against friends, watch it play out, win your league.',
});
</script>

<template>
  <main class="page how">
    <header class="topbar">
      <NuxtLink class="backlink" :to="home" data-sound="back"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>{{ user ? 'Home' : 'Sign in' }}</NuxtLink>
    </header>

    <h1 class="how__title">How to play</h1>
    <p class="muted how__lede">Collect real pro players, field five, out-draft your friends.</p>

    <ol class="steps">
      <li v-for="s in STEPS" :key="s.n" class="step">
        <span class="step__art" aria-hidden="true">
          <!-- 1: a pack -->
          <svg v-if="s.n === 1" viewBox="0 0 48 48"><rect x="12" y="6" width="24" height="36" rx="2" /><path d="M12 13h24M12 35h24M24 19l5 5-5 5-5-5z" class="fill" /></svg>
          <!-- 2: five slots -->
          <svg v-else-if="s.n === 2" viewBox="0 0 48 48"><rect x="4" y="16" width="7" height="16" rx="1" /><rect x="12.5" y="16" width="7" height="16" rx="1" /><rect x="21" y="16" width="7" height="16" rx="1" class="fill" /><rect x="29.5" y="16" width="7" height="16" rx="1" /><rect x="38" y="16" width="7" height="16" rx="1" /></svg>
          <!-- 3: a pick and a ban -->
          <svg v-else-if="s.n === 3" viewBox="0 0 48 48"><circle cx="16" cy="24" r="9" /><path d="M12 24l3 3 5-6" /><circle cx="33" cy="24" r="9" /><path d="M27 18l12 12" /></svg>
          <!-- 4: the map -->
          <svg v-else-if="s.n === 4" viewBox="0 0 48 48"><rect x="7" y="7" width="34" height="34" rx="2" /><path d="M7 41L41 7M12 14h8M28 34h8" /><circle cx="24" cy="24" r="3" class="fill" /></svg>
          <!-- 5: a trophy -->
          <svg v-else viewBox="0 0 48 48"><path d="M15 8h18v9a9 9 0 0 1-18 0zM15 11h-5a5 5 0 0 0 5.5 6.5M33 11h5a5 5 0 0 1-5.5 6.5M24 26v7M17 40h14l-2-7h-10z" /></svg>
        </span>
        <div class="step__text">
          <p class="step__n label">Step {{ s.n }}</p>
          <h2>{{ s.title }}</h2>
          <p>{{ s.body }}</p>
        </div>
        <NuxtLink v-if="user" class="btn btn--quiet btn--sm step__go" :to="s.to">{{ s.cta }}</NuxtLink>
      </li>
    </ol>

    <section class="ideas" aria-label="What wins matches">
      <article class="idea">
        <h2><i class="gem gem--legendary" aria-hidden="true" />Mastery beats raw rating</h2>
        <p>A player is only as good as they are on the champion they are given.</p>
        <dl class="vs">
          <div><dt>92 rating, never played the champion</dt><dd class="num">≈ 64</dd></div>
          <div class="is-win"><dt>78 rating, on their main</dt><dd class="num">≈ 77</dd></div>
        </dl>
        <p class="faint">So a deep champion pool is worth more than a big number. Off-role picks cost a little more on top.</p>
      </article>

      <article class="idea">
        <h2><i class="gem gem--rare" aria-hidden="true" />Chemistry</h2>
        <p>A small bonus for players who belong together:</p>
        <ul class="ticks">
          <li><b class="tnum">+1.5</b> two teammates from the same real team and season</li>
          <li><b class="tnum">+2.5</b> three or more of them</li>
          <li><b class="tnum">+1</b> all five from one region, and <b class="tnum">+1</b> all five from one year</li>
        </ul>
        <p class="faint">Capped at +4.5 a player: a nice edge, never a must.</p>
      </article>

      <article class="idea">
        <h2><i class="coin coin--s" aria-hidden="true" />Sponsors</h2>
        <p>Two slots for contracts that pay you credits on every match you play.</p>
        <ul class="ticks">
          <li>An appearance fee every match, win or lose</li>
          <li>A bonus when your five meets their demand, like "three players from the LCK"</li>
          <li>Three matches on the term, then release them for free</li>
        </ul>
        <p class="faint">Credits buy packs in the shop.</p>
      </article>
    </section>

    <div class="how__end">
      <NuxtLink class="btn btn--lg" :to="user ? '/pack' : '/?mode=up'">{{ user ? 'Back to Home' : 'Create an account' }}</NuxtLink>
    </div>
  </main>
</template>

<style scoped>
.backlink { display: inline-flex; align-items: center; gap: 4px; min-height: 44px; margin-left: -6px; padding-right: 8px; font-size: 13.5px; font-weight: 600; color: var(--ink-2); }
.backlink svg { width: 20px; height: 20px; }
.backlink:hover { color: var(--ink-1); }

.how__title { font-size: clamp(32px, 8vw, 44px); line-height: 0.95; }
.how__lede { margin: 10px 0 24px; font-size: 15px; }

.steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; counter-reset: none; }
.step {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
  padding: 14px;
  border: 1px solid var(--line-1);
  border-radius: var(--radius);
  background: var(--bg-2);
}
.step__art {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border-radius: var(--radius);
  background: var(--bg-0);
  box-shadow: inset 0 0 0 1px var(--line-2);
}
.step__art svg { width: 38px; height: 38px; fill: none; stroke: var(--gold-2); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.step__art svg .fill { fill: var(--gold-2); }
.step__n { margin: 0 0 3px; color: var(--gold-2); }
.step h2 { font-size: 19px; }
.step__text p:last-child { margin: 4px 0 0; color: var(--ink-2); font-size: 14px; line-height: 1.5; }
.step__go { grid-column: 2; justify-self: start; margin-top: 2px; }

.ideas { display: grid; gap: 12px; margin-top: 28px; }
.idea { padding: 16px; border: 1px solid var(--line-1); border-radius: var(--radius); background: var(--bg-2); }
.idea h2 { display: flex; align-items: center; gap: 10px; font-size: 19px; }
.idea p { margin: 8px 0 0; font-size: 14px; line-height: 1.5; color: var(--ink-2); }
.idea p.faint { color: var(--ink-3); font-size: 13px; }

.vs { display: grid; gap: 6px; margin: 12px 0 0; }
.vs div { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-radius: 2px; background: var(--bg-0); }
.vs dt { font-size: 13.5px; color: var(--ink-2); }
.vs dd { margin: 0; font-size: 24px; color: var(--ink-3); }
.vs .is-win dd { color: var(--gold-1); }
.vs .is-win dt { color: var(--ink-1); }

.ticks { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 6px; font-size: 14px; color: var(--ink-1); }
.ticks li { position: relative; padding-left: 18px; line-height: 1.45; }
.ticks li::before { content: ''; position: absolute; left: 1px; top: 0.55em; width: 6px; height: 6px; transform: rotate(45deg); background: var(--gold-2); }
.ticks b { color: var(--gold-1); font-weight: 760; }

.how__end { display: grid; margin-top: 28px; }

@media (min-width: 760px) {
  .ideas { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .how__end { justify-items: start; }
}
</style>
