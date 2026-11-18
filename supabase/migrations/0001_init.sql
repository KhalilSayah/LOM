-- =============================================================================
-- LOM v1 — accounts, catalogue, collection, daily pack
--
-- Forward-only. Run in the Supabase SQL editor, or with the Supabase CLI:
--   supabase db push
--
-- Scope note. docs/07-data-model.md hangs collections off `league_members`,
-- because once leagues exist a collection belongs to a membership, not to a
-- person. v1 has no leagues, so `collection_cards` hangs off `profiles` and the
-- league column is added when leagues land. That migration is a column add plus
-- a backfill into each manager's first membership — cheap, and much cheaper than
-- carrying a one-row-per-user `leagues` table around for a feature that does not
-- exist yet.
--
-- The `champions` lookup table from docs/07 is also deferred: v1 stores the Data
-- Dragon champion key as text. It becomes a foreign key when champion metadata
-- (roles, release patch, icon path) is actually read by something.
-- =============================================================================

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- 1. Profiles
-- -----------------------------------------------------------------------------

create table if not exists profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  handle       text not null unique check (handle ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null,
  created_at   timestamptz not null default now()
);

comment on table profiles is 'One row per auth user. Created by the on_auth_user_created trigger.';

-- A handle from the email local part, de-duplicated with a numeric suffix.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  base_handle text;
  candidate   text;
  n           int := 0;
begin
  base_handle := lower(regexp_replace(split_part(new.email, '@', 1), '[^a-z0-9_]', '', 'g'));
  if length(base_handle) < 3 then
    base_handle := 'manager';
  end if;
  base_handle := left(base_handle, 16);

  candidate := base_handle;
  while exists (select 1 from profiles where handle = candidate) loop
    n := n + 1;
    candidate := left(base_handle, 16) || n::text;
  end loop;

  insert into profiles (id, handle, display_name)
  values (new.id, candidate, coalesce(new.raw_user_meta_data ->> 'display_name', candidate));

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -----------------------------------------------------------------------------
-- 2. Catalogue — written by the pipeline, read by everyone
-- -----------------------------------------------------------------------------

create table if not exists catalogue_versions (
  id         uuid primary key default gen_random_uuid(),
  semver     text not null unique,
  built_at   timestamptz not null default now(),
  source     text not null default 'SEED',
  is_active  boolean not null default false,
  notes      text
);

comment on column catalogue_versions.is_active is
  'Exactly one row should be true. Packs roll against the active version.';

create unique index if not exists catalogue_versions_one_active
  on catalogue_versions ((is_active)) where is_active;

create table if not exists card_definitions (
  id                   uuid primary key default gen_random_uuid(),
  catalogue_version_id uuid not null references catalogue_versions(id) on delete cascade,
  card_key             text not null,
  kind                 text not null default 'PLAYER' check (kind in ('PLAYER', 'COACH')),
  player_name          text not null,
  real_name            text,
  season               int,
  team                 text,
  region               text,
  role                 text check (role in ('TOP', 'JNG', 'MID', 'BOT', 'SUP')),
  ovr                  int not null check (ovr between 40 and 99),
  rarity               text not null check (rarity in ('COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON')),
  sub_stats            jsonb not null,
  accolades            jsonb not null default '[]',
  season_summary       jsonb not null default '{}',
  provenance           jsonb not null default '{}',
  art_champion_key     text,
  art_focus            text,
  portrait_path        text,
  unique (catalogue_version_id, card_key)
);

create index if not exists card_definitions_band_idx
  on card_definitions (catalogue_version_id, rarity, role);
create index if not exists card_definitions_ovr_idx
  on card_definitions (catalogue_version_id, ovr desc);
create index if not exists card_definitions_name_idx
  on card_definitions using gin (to_tsvector('simple', player_name));

create table if not exists card_champion_pool (
  card_definition_id uuid not null references card_definitions(id) on delete cascade,
  champion_key       text not null,
  champion_name      text not null,
  games              int not null default 0,
  winrate            numeric(4,3) not null default 0.500,
  mastery            int not null check (mastery between 0 and 100),
  slot               int not null default 0,
  primary key (card_definition_id, champion_key)
);

create index if not exists card_champion_pool_card_idx
  on card_champion_pool (card_definition_id, slot);

-- -----------------------------------------------------------------------------
-- 3. Collection
-- -----------------------------------------------------------------------------

create table if not exists collection_cards (
  id                 uuid primary key default gen_random_uuid(),
  profile_id         uuid not null references profiles(id) on delete cascade,
  card_definition_id uuid not null references card_definitions(id) on delete cascade,
  level              int not null default 1 check (level between 1 and 10),
  xp                 int not null default 0 check (xp >= 0),
  copies             int not null default 1 check (copies >= 1),
  source             text not null default 'PACK' check (source in ('PACK', 'STARTER', 'GRANT')),
  acquired_at        timestamptz not null default now(),
  unique (profile_id, card_definition_id)
);

create index if not exists collection_cards_profile_idx
  on collection_cards (profile_id, acquired_at desc);

create table if not exists pity_counters (
  profile_id      uuid primary key references profiles(id) on delete cascade,
  since_legendary int not null default 0 check (since_legendary >= 0),
  since_icon      int not null default 0 check (since_icon >= 0),
  packs_opened    int not null default 0 check (packs_opened >= 0),
  updated_at      timestamptz not null default now()
);

-- One pack per manager per pack-day. The unique constraint is the lock: two
-- simultaneous claims race on the insert and exactly one wins.
create table if not exists pack_claims (
  id                 uuid primary key default gen_random_uuid(),
  profile_id         uuid not null references profiles(id) on delete cascade,
  pack_day           date not null,
  claimed_at         timestamptz not null default now(),
  settled_at         timestamptz,
  card_definition_id uuid references card_definitions(id),
  rarity             text check (rarity in ('COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON')),
  was_duplicate      boolean not null default false,
  xp_awarded         int not null default 0,
  unique (profile_id, pack_day)
);

comment on column pack_claims.settled_at is
  'Null means the row was reserved but the roll did not finish. The claim endpoint resumes it.';

create index if not exists pack_claims_profile_idx
  on pack_claims (profile_id, pack_day desc);

-- -----------------------------------------------------------------------------
-- 4. Row-level security
--
-- The client holds the anon key and may read the catalogue and its own rows and
-- nothing else. Every write that matters (rolling a pack, granting a card) goes
-- through a Nitro route holding the service-role key, which bypasses RLS. There
-- is deliberately no client-side insert policy on collection_cards: if there
-- were, a manager could grant themselves Faker.
-- -----------------------------------------------------------------------------

alter table profiles            enable row level security;
alter table catalogue_versions  enable row level security;
alter table card_definitions    enable row level security;
alter table card_champion_pool  enable row level security;
alter table collection_cards    enable row level security;
alter table pity_counters       enable row level security;
alter table pack_claims         enable row level security;

drop policy if exists profiles_select_own on profiles;
create policy profiles_select_own on profiles
  for select to authenticated using (id = auth.uid());

drop policy if exists profiles_update_own on profiles;
create policy profiles_update_own on profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists catalogue_versions_read on catalogue_versions;
create policy catalogue_versions_read on catalogue_versions
  for select to anon, authenticated using (true);

drop policy if exists card_definitions_read on card_definitions;
create policy card_definitions_read on card_definitions
  for select to anon, authenticated using (true);

drop policy if exists card_champion_pool_read on card_champion_pool;
create policy card_champion_pool_read on card_champion_pool
  for select to anon, authenticated using (true);

drop policy if exists collection_cards_select_own on collection_cards;
create policy collection_cards_select_own on collection_cards
  for select to authenticated using (profile_id = auth.uid());

drop policy if exists pity_counters_select_own on pity_counters;
create policy pity_counters_select_own on pity_counters
  for select to authenticated using (profile_id = auth.uid());

drop policy if exists pack_claims_select_own on pack_claims;
create policy pack_claims_select_own on pack_claims
  for select to authenticated using (profile_id = auth.uid());
