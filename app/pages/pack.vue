<script setup lang="ts">
interface PackStatus {
  packDay: string;
  nextOpensAt: string;
  serverNow: string;
  hour: number;
  timeZone: string;
  available: boolean;
  catalogue: string | null;
  credits: number;
  claim: null | { rarity: string; wasDuplicate: boolean; xpAwarded: number; card: any };
  pity: { sinceLegendary: number; sinceIcon: number; packsOpened: number; legendaryIn: number; iconIn: number };
  collectionCount: number;
}

const { packReady } = usePackSignal();
const { incoming: duelsIncoming, drafting: duelsDrafting } = useDuelSignal();

// A gifted pack keeps saying so until it is opened: the toast in the layout is shown once,
// and this is the standing reminder. Opening happens in the shop, which is the one screen
// that can already reveal five cards at a time.
const { gifts } = useGiftSignal();
const gift = computed(() => gifts.value[0] ?? null);
const moreGifts = computed(() => Math.max(0, gifts.value.length - 1));

const status = ref<PackStatus | null>(null);
const loading = ref(true);
const opening = ref(false);
const error = ref('');

/** The pack just opened in this session, so the scene plays. */
const freshPull = ref<null | { rarity: string; wasDuplicate: boolean; xpAwarded: number; card: any }>(null);
const revealed = ref(false);

async function load() {
  try {
    status.value = await $fetch<PackStatus>('/api/pack/status');
    packReady.value = status.value.available;
    // Server time wins; a phone with a wrong clock should still see the right countdown.
    drift = new Date(status.value.serverNow).getTime() - Date.now();
    tick();
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'Could not reach the server.';
  } finally {
    loading.value = false;
  }
}

async function open() {
  if (!status.value?.available || opening.value) return;
  opening.value = true;
  error.value = '';
  try {
    const result = await $fetch<any>('/api/pack/claim', { method: 'POST' });
    freshPull.value = result;
    packReady.value = false;
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'The pack did not open. Try again.';
    await load();
  } finally {
    opening.value = false;
  }
}

// --- countdown ---------------------------------------------------------------

let drift = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const remaining = ref('');

function tick() {
  if (!status.value) return;
  const ms = new Date(status.value.nextOpensAt).getTime() - (Date.now() + drift);
  if (ms <= 0) {
    remaining.value = '00:00:00';
    if (!status.value.available) load();
    return;
  }
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  remaining.value = `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

onMounted(() => {
  load();
  timer = setInterval(tick, 1000);
});
onBeforeUnmount(() => clearInterval(timer));

const alreadyOpened = computed(() => !freshPull.value && status.value?.claim);

useHead({ title: 'Pack — LOM' });
</script>

<template>
  <main class="page">
    <header class="topbar">
      <h1>Daily pack</h1>
      <span class="topbar__meta tnum">{{ status?.credits ?? 0 }} cr &middot; {{ status?.collectionCount ?? 0 }} cards</span>
    </header>

    <p v-if="error" class="notice notice--bad">{{ error }}</p>

    <div v-if="loading" class="skeleton pack-skeleton" />

    <!-- just opened: the full reveal -->
    <section v-else-if="freshPull" class="reveal">
      <PackScene
        :card="freshPull.card"
        label="Daily pack"
        auto-open
        @revealed="revealed = true"
        @kept="navigateTo('/collection')"
      />
      <p v-if="revealed && freshPull.wasDuplicate" class="notice">
        You already had {{ freshPull.card.playerName }} {{ freshPull.card.season }} —
        the copy became <strong>+{{ freshPull.xpAwarded }} XP</strong> on the card you hold.
      </p>
    </section>

    <!-- no cards loaded yet -->
    <section v-else-if="status && !status.catalogue" class="empty">
      <h2>No catalogue loaded</h2>
      <p>
        There are no cards to roll against yet. Build one and push it to Supabase:
        <code>npm run catalogue:build</code> then <code>npm run catalogue:push</code>.
      </p>
    </section>

    <!-- a pack is waiting -->
    <section v-else-if="status?.available" class="waiting">
      <div class="waiting__art" aria-hidden="true">
        <span class="waiting__pack" />
      </div>
      <h2>Your pack is ready</h2>
      <p class="muted">One card. Tap to open it.</p>
      <button class="btn btn--block" :disabled="opening" @click="open">
        {{ opening ? 'Opening' : 'Open pack' }}
      </button>
    </section>

    <!-- already opened today -->
    <section v-else-if="alreadyOpened" class="done">
      <p class="eyebrow">Today's pull</p>
      <div class="done__card">
        <LomCard :card="status!.claim!.card" />
      </div>
      <p v-if="status!.claim!.wasDuplicate" class="notice">
        Duplicate — it became +{{ status!.claim!.xpAwarded }} XP on the card you hold.
      </p>
      <div class="panel countdown">
        <p class="eyebrow">Next pack</p>
        <p class="countdown__value tnum">{{ remaining }}</p>
        <p class="faint countdown__note">
          Packs open at {{ status!.hour }}:00 {{ status!.timeZone.replace('_', ' ') }}.
        </p>
      </div>
    </section>

    <section v-else class="empty">
      <h2>No pack right now</h2>
      <p>The next one lands in <strong class="tnum">{{ remaining }}</strong>.</p>
    </section>

    <!-- pity, always visible: hidden pity is just anxiety -->
    <section v-if="status && !freshPull" class="panel pity">
      <p class="eyebrow">Odds</p>
      <dl class="pity__grid">
        <div>
          <dt>Packs opened</dt>
          <dd class="tnum">{{ status.pity.packsOpened }}</dd>
        </div>
        <div>
          <dt>Legendary within</dt>
          <dd class="tnum">{{ status.pity.legendaryIn }}</dd>
        </div>
        <div>
          <dt>Icon within</dt>
          <dd class="tnum">{{ status.pity.iconIn }}</dd>
        </div>
      </dl>
    </section>

    <!-- a challenge is the one thing that arrives on its own, so it goes first -->
    <NuxtLink v-if="duelsIncoming" class="panel duelcall" to="/duels">
      <span>
        <strong>{{ duelsIncoming }} {{ duelsIncoming === 1 ? 'challenge' : 'challenges' }} waiting</strong>
        <span class="faint duelcall__sub">Someone wants to draft against you.</span>
      </span>
      <span class="duelcall__go">Open</span>
    </NuxtLink>
    <NuxtLink v-else-if="duelsDrafting" class="panel duelcall" to="/duels">
      <span>
        <strong>A draft is live</strong>
        <span class="faint duelcall__sub">You have a duel in progress.</span>
      </span>
      <span class="duelcall__go">Back to it</span>
    </NuxtLink>

    <!-- a free pack nobody asked for, waiting to be rolled -->
    <NuxtLink v-if="gift && !freshPull" class="panel giftcall" to="/shop">
      <span>
        <strong>{{ gift.title }}</strong>
        <span class="faint giftcall__sub">
          {{ gift.packName }} — free.
          <template v-if="moreGifts">
            {{ moreGifts }} more {{ moreGifts === 1 ? 'gift' : 'gifts' }} after it.
          </template>
        </span>
      </span>
      <span class="giftcall__go">Open</span>
    </NuxtLink>

    <!-- more than one card a day, for anyone with Credits to spend -->
    <NuxtLink v-if="status && !freshPull" class="panel shoplink" to="/shop">
      <span>
        <strong>More packs</strong>
        <span class="faint shoplink__sub">Squad packs, and better odds for a price.</span>
      </span>
      <span class="shoplink__credits tnum">{{ status.credits }} cr</span>
    </NuxtLink>
  </main>
</template>

<style scoped>
.pack-skeleton { height: 58vh; }

.shoplink {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  text-decoration: none;
  color: inherit;
}
.shoplink__sub { display: block; font-size: 12px; margin-top: 2px; }
.shoplink__credits { font-weight: 700; color: var(--accent, #67d3f2); white-space: nowrap; }

.duelcall {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  text-decoration: none;
  color: inherit;
  border-color: var(--accent, #67d3f2);
}
.duelcall__sub { display: block; font-size: 12px; margin-top: 2px; }
.duelcall__go { font-weight: 700; color: var(--accent, #67d3f2); white-space: nowrap; }

.giftcall {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  text-decoration: none;
  color: inherit;
  border-color: var(--accent, #67d3f2);
  background: color-mix(in oklab, var(--surface) 92%, var(--accent));
}
.giftcall__sub { display: block; font-size: 12px; margin-top: 2px; }
.giftcall__go { font-weight: 700; color: var(--accent, #67d3f2); white-space: nowrap; }

.empty code {
  font-family: ui-monospace, 'SFMono-Regular', monospace;
  font-size: 0.86em;
  padding: 0.12em 0.4em;
  border-radius: 4px;
  background: var(--surface-2);
  color: var(--ink);
}

.waiting {
  display: grid;
  justify-items: center;
  gap: 10px;
  text-align: center;
  padding: 18px 0 24px;
}
.waiting h2 { font-size: 22px; }
.waiting .btn { max-width: 320px; margin-top: 8px; }
.waiting__art {
  display: grid;
  place-items: center;
  width: 100%;
  padding: 20px 0 14px;
}
.waiting__pack {
  width: min(58vw, 210px);
  aspect-ratio: 63 / 96;
  border-radius: 12px;
  background:
    linear-gradient(158deg, #1f6b72 0%, #10303a 44%, #07161d 100%);
  box-shadow:
    inset 0 0 0 1px rgba(143, 240, 228, 0.5),
    inset 0 0 40px rgba(0, 0, 0, 0.5),
    0 22px 44px rgba(0, 0, 0, 0.55),
    0 0 60px rgba(110, 240, 220, 0.14);
  position: relative;
  animation: breathe 3.4s ease-in-out infinite;
}
.waiting__pack::after {
  content: '';
  position: absolute;
  inset: 11% 6% auto;
  height: 7px;
  background: repeating-linear-gradient(135deg, rgba(143, 240, 228, 0.6) 0 3px, transparent 3px 7px);
}
@keyframes breathe {
  0%, 100% { transform: translateY(0) scale(1); }
  50% { transform: translateY(-6px) scale(1.012); }
}

.done { display: grid; gap: 12px; }
.done__card { max-width: 300px; margin: 0 auto; width: 100%; }

.countdown { text-align: center; }
.countdown__value {
  font-family: var(--font-display);
  font-size: 34px;
  font-weight: 700;
  letter-spacing: 0.02em;
  margin: 4px 0 2px;
}
.countdown__note { font-size: 12.5px; margin: 0; }

.pity { margin-top: 14px; }
.pity__grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin: 8px 0 0;
}
.pity__grid dt {
  font-family: var(--font-label);
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.pity__grid dd {
  margin: 2px 0 0;
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 700;
}

.reveal { display: grid; gap: 12px; }

@media (prefers-reduced-motion: reduce) {
  .waiting__pack { animation: none; }
}
</style>
