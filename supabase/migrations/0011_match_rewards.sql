-- =============================================================================
-- 0011 — Match rewards
--
-- Forward-only and re-runnable. Run in the Supabase SQL editor, or:
--   supabase db push
--
-- docs/01 section 5 has always said what a match pays: 50 Credits for playing,
-- 100 more for winning, 25 per S-grade, 200 for the first win of a season, and
-- card XP to the five who played. None of it was wired up, so the only Credits
-- in the game came from duplicate pulls — the shop was funded by the thing the
-- shop sells. This is the faucet.
--
-- One row per manager per duel, and the unique index is the whole idempotency
-- story. finish() in server/utils/duelRun.ts can be reached twice in the same
-- instant by two clients nudging the same expired deadline; the insert here is
-- what makes the second one a no-op instead of a second payday. Same shape as
-- pack_claims, for the same reason.
-- =============================================================================

create table if not exists match_rewards (
  id            uuid primary key default gen_random_uuid(),
  duel_id       uuid not null references duels(id) on delete cascade,
  profile_id    uuid not null references profiles(id) on delete cascade,

  -- Denormalised from the duel so a payout can be audited without rebuilding
  -- the match: what it was, whether it counted, and what it paid.
  won           boolean not null default false,
  ghost         boolean not null default false,
  credits       int not null default 0 check (credits >= 0),
  card_xp       int not null default 0 check (card_xp >= 0),

  -- The receipt: { lines: [{label, credits}], cardXp: [...], sponsors: [...] }.
  -- The result screen renders this rather than recomputing it, so what the
  -- manager reads is what the ledger actually paid.
  detail        jsonb not null default '{}'::jsonb,

  -- The pack-day window the match settled in (server/utils/packDay.ts), so the
  -- Ghost allowance in shared/rewards.ts can be counted without a scan.
  pack_day      date,

  created_at    timestamptz not null default now(),

  unique (duel_id, profile_id)
);

comment on table match_rewards is
  'One payout per manager per duel. The unique index is the idempotency lock: a duel that finishes twice pays once.';

create index if not exists match_rewards_profile_idx
  on match_rewards (profile_id, created_at desc);

-- The Ghost allowance counts paid Ghost matches inside one pack-day.
create index if not exists match_rewards_ghost_day_idx
  on match_rewards (profile_id, pack_day)
  where ghost;

-- -----------------------------------------------------------------------------
-- Row-level security
--
-- A manager reads their own payouts and writes none of them. Everything that
-- writes here holds the service-role key, which is the same rule as
-- collection_cards and for the same reason: a client that could insert a
-- match_rewards row could pay itself.
-- -----------------------------------------------------------------------------

alter table match_rewards enable row level security;

drop policy if exists match_rewards_select_own on match_rewards;
create policy match_rewards_select_own on match_rewards
  for select using (profile_id = auth.uid());
