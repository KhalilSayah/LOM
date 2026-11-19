-- =============================================================================
-- LOM v1 — the roster: five slots, one per role, filled from owned cards
--
-- Forward-only. Run after 0002_discovery.sql.
--
-- docs/01-game-loop.md calls this the lineup and attaches it to a fixture: you set
-- it before each match and yesterday's is pre-filled. v1 has no fixtures, so there is
-- one standing roster per manager and no history — the table is keyed on the manager
-- and the role, which is exactly the shape "one card per role slot" takes when there
-- is only one of them.
--
-- When fixtures land, this becomes a per-fixture lineup. That migration adds a
-- fixture column and widens the primary key, with the standing roster backfilled as
-- the default lineup. Carrying a fixture column now, with one magic null value in it
-- for "the standing one", would be the same work plus a lie in every query.
--
-- Same reasoning as 0001 for collections: a roster hangs off `profiles` in v1 and
-- moves to `league_members` when leagues exist.
-- =============================================================================

create table if not exists roster_slots (
  profile_id         uuid not null references profiles(id) on delete cascade,
  role               text not null check (role in ('TOP', 'JNG', 'MID', 'BOT', 'SUP')),
  collection_card_id uuid not null references collection_cards(id) on delete cascade,
  updated_at         timestamptz not null default now(),
  primary key (profile_id, role),
  -- A card cannot hold two slots. The role check on the card itself makes this hard
  -- to reach today, but it is the constraint that keeps being true once off-role
  -- play exists, and it is free.
  unique (profile_id, collection_card_id)
);

comment on table roster_slots is
  'The manager''s standing five. One row per filled slot: an empty slot is a missing row, not a null card.';

comment on column roster_slots.collection_card_id is
  'Points at the owned copy, not the definition — the roster follows the card''s level and XP.';

-- The slot is named by the primary key, so the only index worth having is the one
-- that answers "is this card in my roster", which the collection screen asks for
-- every tile it draws.
create index if not exists roster_slots_card_idx
  on roster_slots (profile_id, collection_card_id);

-- -----------------------------------------------------------------------------
-- Row-level security
--
-- Readable by its owner, writable by nobody holding the anon key. A roster write has
-- to check that the card is yours and that its role fits the slot, and a policy
-- cannot express the second half without reading two more tables — so the write goes
-- through /api/roster/slot like every other write that matters (0001, section 4).
-- -----------------------------------------------------------------------------

alter table roster_slots enable row level security;

drop policy if exists roster_slots_select_own on roster_slots;
create policy roster_slots_select_own on roster_slots
  for select to authenticated using (profile_id = auth.uid());
