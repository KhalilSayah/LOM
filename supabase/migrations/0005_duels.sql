-- =============================================================================
-- 0005 — Duels: challenge, draft, simulate
--
-- Forward-only and re-runnable. Run in the Supabase SQL editor, or:
--   supabase db push
--
-- docs/05 describes a draft that happens inside a scheduled fixture in a league.
-- Neither leagues nor fixtures exist yet, and waiting for them would mean the
-- draft — the best part of the game — stays unbuilt the longest. So a duel is a
-- fixture with the league taken out: two managers, agreed directly, drafted the
-- same way, simulated by the same engine. When leagues land, a fixture becomes
-- another thing that can open a duel.
--
-- The whole draft lives in these two tables and the server is the only writer.
-- Clients poll; nothing a client sends is trusted beyond "it is my turn and this
-- is my action", which the server checks against the action log itself.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The duel
-- -----------------------------------------------------------------------------

create table if not exists duels (
  id                   uuid primary key default gen_random_uuid(),
  challenger_id        uuid not null references profiles(id) on delete cascade,
  opponent_id          uuid not null references profiles(id) on delete cascade,
  status               text not null default 'PENDING'
                         check (status in ('PENDING', 'DECLINED', 'CANCELLED', 'DRAFTING', 'COMPLETE')),

  -- Sides are assigned when the challenge is accepted, not when it is sent, so
  -- the person who clicks first does not also choose who gets last pick.
  blue_id              uuid references profiles(id) on delete set null,
  red_id               uuid references profiles(id) on delete set null,

  -- Pinned once, at accept. docs/03 section 9 is emphatic that a card must not
  -- change under someone mid-season; it must certainly not change mid-draft.
  catalogue_version_id uuid references catalogue_versions(id),
  seed                 text not null,

  -- The five cards each side brings, frozen at accept. docs/05 section 1 locks
  -- lineups before the draft opens; here that lock is simply a copy, which also
  -- means a replay still renders if a card leaves the collection afterwards.
  blue_lineup          jsonb,
  red_lineup           jsonb,

  -- Index into the 20-action order in shared/draft.ts. 20 means the draft is done.
  turn                 int not null default 0 check (turn between 0 and 20),
  deadline_at          timestamptz,
  bonus                jsonb not null default '{"BLUE": 60, "RED": 60}'::jsonb,

  result               jsonb,
  created_at           timestamptz not null default now(),
  accepted_at          timestamptz,
  completed_at         timestamptz,
  updated_at           timestamptz not null default now(),

  constraint duels_not_self check (challenger_id <> opponent_id)
);

comment on column duels.deadline_at is
  'When the current action auto-locks. Authoritative: a client never decides an expiry.';
comment on column duels.bonus is
  'Remaining bonus seconds per side, consumed when an action timer runs out (docs/05 3.3).';

-- One live challenge in a given direction at a time. Settled duels are kept, so
-- the index is partial rather than a plain unique.
create unique index if not exists duels_one_live_per_pair
  on duels (challenger_id, opponent_id)
  where status in ('PENDING', 'DRAFTING');

create index if not exists duels_challenger_idx on duels (challenger_id, created_at desc);
create index if not exists duels_opponent_idx on duels (opponent_id, created_at desc);
create index if not exists duels_live_idx on duels (status, deadline_at)
  where status = 'DRAFTING';

-- -----------------------------------------------------------------------------
-- 2. The action log
--
-- Append-only, and the draft's actual state. `duels.turn` is a cursor over it
-- rather than a second opinion: the legality check reads the log, so a lost or
-- duplicated write shows up as a conflict on the primary key instead of as two
-- people picking the same champion.
-- -----------------------------------------------------------------------------

create table if not exists duel_actions (
  duel_id       uuid not null references duels(id) on delete cascade,
  idx           int not null check (idx between 0 and 19),
  side          text not null check (side in ('BLUE', 'RED')),
  kind          text not null check (kind in ('BAN', 'PICK')),
  champion_key  text not null,
  champion_name text not null,
  -- Picks carry a lineup slot (docs/05 section 3.1); bans do not.
  slot          text check (slot in ('TOP', 'JNG', 'MID', 'BOT', 'SUP')),
  auto          boolean not null default false,
  locked_at     timestamptz not null default now(),
  primary key (duel_id, idx),
  constraint duel_actions_pick_has_slot check ((kind = 'PICK') = (slot is not null))
);

-- A champion is gone once it is named, whether banned or picked.
create unique index if not exists duel_actions_champion_once
  on duel_actions (duel_id, champion_key);

-- A lineup slot can only be filled once per side.
create unique index if not exists duel_actions_slot_once
  on duel_actions (duel_id, side, slot)
  where slot is not null;

-- -----------------------------------------------------------------------------
-- 3. Row-level security
--
-- A participant reads their own duels and everything in them. Nobody writes:
-- every action goes through a Nitro route holding the service-role key, which is
-- what makes "it is not your turn" and "that champion is gone" enforceable at all.
-- -----------------------------------------------------------------------------

alter table duels        enable row level security;
alter table duel_actions enable row level security;

drop policy if exists duels_select_own on duels;
create policy duels_select_own on duels
  for select using (challenger_id = auth.uid() or opponent_id = auth.uid());

drop policy if exists duel_actions_select_own on duel_actions;
create policy duel_actions_select_own on duel_actions
  for select using (
    exists (
      select 1 from duels d
      where d.id = duel_actions.duel_id
        and (d.challenger_id = auth.uid() or d.opponent_id = auth.uid())
    )
  );
