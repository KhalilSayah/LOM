-- =============================================================================
-- 0018 — Team strategy: the preset a manager's five play under
--
-- Forward-only and re-runnable. Run in the Supabase SQL editor.
--
-- docs/01 gives every team one of three team-wide presets for a match, and the
-- sim has played them since it was written (packages/sim/src/balance.js
-- BALANCE.strategy). Nothing let a manager choose one; every lineup played
-- STANDARD. This stores the choice, one row per manager.
--
-- A table of its own rather than a column on `profiles`: profiles carries an
-- update-own RLS policy (0001), so any column there is writable straight from
-- the browser with the anon key. A strategy changes every match a manager plays,
-- so like the roster itself it is written only through a server route
-- (/api/roster/strategy), and this table grants the browser read and nothing else.
--
-- The name is not checked against a list here. The sim owns the presets, and a
-- balance pass that adds one should not need a migration; the server refuses any
-- name BALANCE.strategy does not have, and server/utils/strategy.ts reads an
-- unknown stored name as STANDARD.
-- =============================================================================

create table if not exists roster_strategy (
  profile_id uuid primary key references profiles(id) on delete cascade,
  strategy   text not null default 'STANDARD' check (strategy ~ '^[A-Z_]{2,32}$'),
  updated_at timestamptz not null default now()
);

comment on table roster_strategy is
  'The team strategy preset a manager plays under. Missing row = STANDARD. Written only by /api/roster/strategy.';

alter table roster_strategy enable row level security;

drop policy if exists roster_strategy_select_own on roster_strategy;
create policy roster_strategy_select_own on roster_strategy
  for select to authenticated using (profile_id = auth.uid());
