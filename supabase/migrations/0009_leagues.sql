-- =============================================================================
-- 0009 — Leagues: a host, an invite code, members, and a generated schedule
--
-- Forward-only and re-runnable. Run in the Supabase SQL editor, or:
--   supabase db push
--
-- docs/01 section 2 is the shape: a manager creates a league with a timezone and a
-- match hour, the app mints an invite code, others join with it, and the league
-- locks when the owner presses Start season — at which point the fixtures for the
-- whole season exist as rows, so every manager can see who they play and when.
--
-- One deliberate departure from docs/07. There, collections hang off
-- `league_members`: a collection per league, its own credits, its own starter squad.
-- Everything already built here — packs, pity, the roster, discovery — hangs off
-- `profiles`, and moving all of it is a migration of its own with a data copy in the
-- middle. So for now a league is a *container for membership and a calendar*: who is
-- in it, who plays whom, on which evening. A manager brings the one collection they
-- have. When per-league collections land, `league_members` is already the row they
-- will hang off, which is why it has an id of its own and fixtures point at it
-- rather than at a profile.
--
-- Nothing here is writable by a client. Creating, joining and launching all go
-- through Nitro routes holding the service-role key, because "the league is full",
-- "the season has already started" and "only the owner starts it" are only
-- enforceable where the client cannot reach.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The league
-- -----------------------------------------------------------------------------

create table if not exists leagues (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (length(btrim(name)) between 2 and 40),
  owner_id           uuid not null references profiles(id) on delete cascade,

  -- Six characters of the same Crockford base32 alphabet as a share code. Short
  -- because it is read out loud in a group chat, and it only has to be unguessable
  -- for the few days a league spends forming: 32^6 ≈ 1.07e9.
  invite_code        text not null,

  -- An IANA zone, not an offset: the match hour is a wall-clock time and has to
  -- survive a DST change in the middle of a season.
  timezone           text not null default 'Europe/Paris',
  match_hour         time not null default '20:30',
  season_length_days int  not null default 14 check (season_length_days between 2 and 60),

  -- The catalogue the league plays with, pinned when it launches (docs/03 section 9):
  -- a card must not change under someone mid-season.
  catalogue_version_id uuid references catalogue_versions(id),

  status             text not null default 'FORMING'
                       check (status in ('FORMING', 'ACTIVE', 'FINISHED')),

  -- The calendar date, in the league's own timezone, that day 1 falls on. Set at
  -- launch, and the anchor every fixture date is counted from.
  starts_on          date,

  created_at         timestamptz not null default now(),
  started_at         timestamptz,
  finished_at        timestamptz
);

comment on table leagues is
  'A private league of 2-6 managers. Created FORMING, locked ACTIVE by the owner.';
comment on column leagues.invite_code is
  'Six Crockford base32 characters. The whole of the join authorisation while FORMING.';

-- The same unbiased mint as gen_share_code (0002), at six characters and unique
-- against leagues. gen_random_bytes lives in `extensions` on Supabase, hence the
-- pinned search_path.
create or replace function public.gen_league_code()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  candidate text;
  i int;
begin
  loop
    candidate := '';
    for i in 1..6 loop
      candidate := candidate || substr(alphabet, 1 + (get_byte(gen_random_bytes(1), 0) % 32), 1);
    end loop;
    exit when not exists (select 1 from leagues where invite_code = candidate);
  end loop;
  return candidate;
end;
$$;

-- A default cannot see the table it has to stay unique against, so the code is
-- minted in a trigger, the same way a share code is.
create or replace function public.leagues_set_invite_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.invite_code is null then
    new.invite_code := public.gen_league_code();
  end if;
  return new;
end;
$$;

drop trigger if exists leagues_invite_code on leagues;
create trigger leagues_invite_code
  before insert on leagues
  for each row execute function public.leagues_set_invite_code();

-- NOT NULL is checked after BEFORE INSERT triggers have run, so the column can be
-- both not-null and trigger-filled; an insert that omits it is fine.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leagues_invite_code_shape') then
    alter table leagues add constraint leagues_invite_code_shape
      check (invite_code ~ '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$');
  end if;
end;
$$;

create unique index if not exists leagues_invite_code_key on leagues (invite_code);
create index if not exists leagues_owner_idx on leagues (owner_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 2. Membership
--
-- `team_name` is the manager's name inside this league. It defaults to their
-- display name at join time and is theirs to change: the same person can be
-- "Khalil" in one league and "T1 Fanclub" in another, which is half the fun of a
-- private league.
-- -----------------------------------------------------------------------------

create table if not exists league_members (
  id         uuid primary key default gen_random_uuid(),
  league_id  uuid not null references leagues(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  team_name  text not null check (length(btrim(team_name)) between 1 and 24),
  is_owner   boolean not null default false,
  joined_at  timestamptz not null default now(),
  unique (league_id, profile_id)
);

create index if not exists league_members_profile_idx on league_members (profile_id);
create index if not exists league_members_league_idx on league_members (league_id, joined_at);

-- The 2-6 band from docs/01 section 2. Checked in the route as well, where it can
-- say "this league is full" in words, but enforced here too: the route checks the
-- count and then inserts, and two people tapping a shared invite link at the same
-- moment would both pass that check.
create or replace function public.league_members_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  select count(*) into n from league_members where league_id = new.league_id;
  if n >= 6 then
    raise exception 'league_full' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists league_members_cap_check on league_members;
create trigger league_members_cap_check
  before insert on league_members
  for each row execute function public.league_members_cap();

-- -----------------------------------------------------------------------------
-- 3. The schedule
--
-- Generated in one transaction at launch and then read, never recomputed: a
-- manager who has seen "you play Sam on Thursday" must still play Sam on Thursday
-- after somebody else leaves the app open for a week.
--
-- `red_member_id` null is a Ghost fixture (docs/01 section 6) — an odd number of
-- managers means somebody is unpaired each round, and the spec's answer is that they
-- play a Ghost rather than sit out. A rest day is a row with no pairing at all, so
-- the calendar is complete and the UI never has to infer a gap.
--
-- `duel_id` is the forward link: a fixture's draft is a duel room, which already
-- exists and already works (0005, 0007). Playing a league fixture means opening a
-- duel and pointing the fixture at it.
-- -----------------------------------------------------------------------------

create table if not exists league_fixtures (
  id             uuid primary key default gen_random_uuid(),
  league_id      uuid not null references leagues(id) on delete cascade,
  day_index      int  not null check (day_index >= 1),

  stage          text not null default 'REGULAR'
                   check (stage in ('REGULAR', 'GHOST', 'REST')),

  blue_member_id uuid references league_members(id) on delete cascade,
  red_member_id  uuid references league_members(id) on delete cascade,

  -- The instant the match hour falls on for this day, resolved once against the
  -- league's timezone. Clients count down to it and never compute it.
  scheduled_at   timestamptz,

  status         text not null default 'SCHEDULED'
                   check (status in ('SCHEDULED', 'PLAYING', 'FINAL', 'VOID')),

  duel_id        uuid references duels(id) on delete set null,
  winner_member_id uuid references league_members(id) on delete set null,

  created_at     timestamptz not null default now(),

  -- A rest day has no sides; anything else has at least a blue one.
  constraint league_fixtures_rest_has_no_sides check (
    (stage = 'REST') = (blue_member_id is null)
  ),
  constraint league_fixtures_ghost_has_no_red check (
    stage <> 'GHOST' or red_member_id is null
  ),
  constraint league_fixtures_not_self check (
    red_member_id is null or blue_member_id <> red_member_id
  )
);

-- A manager plays at most once per day, on either side. Two partial indexes rather
-- than one expression: a day's rows are inserted together, and this is what makes a
-- double-tapped Start season fail loudly instead of generating the season twice.
create unique index if not exists league_fixtures_blue_once
  on league_fixtures (league_id, day_index, blue_member_id)
  where blue_member_id is not null;

create unique index if not exists league_fixtures_red_once
  on league_fixtures (league_id, day_index, red_member_id)
  where red_member_id is not null;

create unique index if not exists league_fixtures_rest_once
  on league_fixtures (league_id, day_index)
  where stage = 'REST';

create index if not exists league_fixtures_day_idx on league_fixtures (league_id, day_index);
create index if not exists league_fixtures_when_idx on league_fixtures (scheduled_at)
  where status = 'SCHEDULED';

-- -----------------------------------------------------------------------------
-- 4. Row-level security
--
-- A member reads their league, everyone in it, and the whole calendar. Nobody
-- writes: the routes hold the service-role key.
--
-- `is_league_member` is security definer so the policy on `league_members` can ask
-- about `league_members` without recursing through its own policy.
-- -----------------------------------------------------------------------------

create or replace function public.is_league_member(p_league uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from league_members lm
    where lm.league_id = p_league and lm.profile_id = auth.uid()
  );
$$;

alter table leagues         enable row level security;
alter table league_members  enable row level security;
alter table league_fixtures enable row level security;

drop policy if exists leagues_select_mine on leagues;
create policy leagues_select_mine on leagues
  for select using (public.is_league_member(id) or owner_id = auth.uid());

drop policy if exists league_members_select_same on league_members;
create policy league_members_select_same on league_members
  for select using (public.is_league_member(league_id));

drop policy if exists league_fixtures_select_same on league_fixtures;
create policy league_fixtures_select_same on league_fixtures
  for select using (public.is_league_member(league_id));

-- -----------------------------------------------------------------------------
-- 5. Reading a league member's profile
--
-- Being in a league together is a reason to see each other's handle without having
-- been handed a share code — the league screen lists everyone, and a list of
-- uuids is not a list of people. 0002 left `profiles` readable only by its owner,
-- so this adds the one case that membership earns.
-- -----------------------------------------------------------------------------

drop policy if exists profiles_select_leaguemates on profiles;
create policy profiles_select_leaguemates on profiles
  for select using (
    exists (
      select 1
      from league_members mine
      join league_members theirs on theirs.league_id = mine.league_id
      where mine.profile_id = auth.uid() and theirs.profile_id = profiles.id
    )
  );
