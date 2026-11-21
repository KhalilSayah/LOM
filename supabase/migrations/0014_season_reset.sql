-- =============================================================================
-- 0014 — Season reset: a league that can be played more than once
--
-- Forward-only and re-runnable. Run in the Supabase SQL editor, or:
--   supabase db push
--
-- **Run after 0013.** It re-scopes indexes 0009 and 0013 created, adds a column to
-- `league_fixtures`, and reads `leagues.season` which 0013 adds. It also inserts a
-- row into `pack_types` from 0004 and uses `grant_pack_gift` from 0008 at run time.
--
-- 0013 gave a season an ending: a bracket, a champion, and the placings. It left the
-- other half of docs/01 section 7 undone, and said so — point 4, "a new season can be
-- started by the league owner. New fixtures, standings cleared." `leagues.season`
-- existed and the payout lock was already keyed on it, so a second season *could*
-- pay; what blocked it was the fixtures. Every unique index on `league_fixtures` was
-- scoped to `(league_id, day_index, ...)`, so a second schedule collided with the
-- first on day 1, and the bracket slot collided outright.
--
-- The fix is the obvious one and it is the reason it was worth waiting for: a fixture
-- belongs to a season. Nothing is deleted at a reset — season 1's calendar, results,
-- replays and standings are all still there to be read, which is what "standings
-- cleared" has to mean in a game whose whole pitch is that your collection and your
-- history persist. The table clears because it is now a question about *this* season,
-- not because anything was thrown away.
--
-- Three parts:
--
--   1. `league_fixtures.season`, and every unique index re-scoped to include it.
--   2. `league_seasons` — the honours board docs/01 section 7 point 1 asks for. One
--      row per season a league has played, with its champion.
--   3. The Season Pack of point 5, as a pack type nobody can buy.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. A fixture belongs to a season
--
-- Default 1 so every fixture that already exists belongs to the season that is
-- already being played, and `leagues.season` (0013, also default 1) agrees with it
-- without a backfill.
-- -----------------------------------------------------------------------------

alter table league_fixtures add column if not exists season int not null default 1;

do $fxseason$
begin
  if not exists (select 1 from pg_constraint where conname = 'league_fixtures_season_positive') then
    alter table league_fixtures add constraint league_fixtures_season_positive check (season >= 1);
  end if;
end $fxseason$;

comment on column league_fixtures.season is
  'Which season of this league this fixture belongs to. Old seasons are kept, never deleted.';

-- The same four guarantees as before, one season at a time.
--
-- Dropped and recreated rather than added alongside: leaving the old ones in place
-- would keep exactly the collision this migration exists to remove, and they protect
-- nothing the new ones do not. A manager still plays at most once a day, a day still
-- has at most one rest row, and a league still has at most one of each bracket slot —
-- all of it now per season.
drop index if exists league_fixtures_blue_once;
drop index if exists league_fixtures_red_once;
drop index if exists league_fixtures_rest_once;
drop index if exists league_fixtures_bracket_slot;

create unique index if not exists league_fixtures_blue_once
  on league_fixtures (league_id, season, day_index, blue_member_id)
  where blue_member_id is not null;

create unique index if not exists league_fixtures_red_once
  on league_fixtures (league_id, season, day_index, red_member_id)
  where red_member_id is not null;

create unique index if not exists league_fixtures_rest_once
  on league_fixtures (league_id, season, day_index)
  where stage = 'REST';

create unique index if not exists league_fixtures_bracket_slot
  on league_fixtures (league_id, season, bracket_key)
  where bracket_key is not null;

-- Every read of a calendar is now "this league, this season", so the ordinary index
-- should be too.
drop index if exists league_fixtures_day_idx;
create index if not exists league_fixtures_day_idx
  on league_fixtures (league_id, season, day_index);

-- -----------------------------------------------------------------------------
-- 2. The honours board
--
-- docs/01 section 7 point 1: "champion is recorded in the league's honours board". A
-- board is more than one entry, and `leagues.champion_member_id` from 0013 can only
-- ever hold one — so it is read as the champion of the league's *current* season,
-- null while that season is still being played and cleared when the next one starts.
-- This is the record that outlives it.
--
-- Written when a season *finishes*, not when the next one starts, so a league that
-- never plays again still has its honours. `season_rewards` already holds where
-- everybody came and what they were paid; this holds the facts about the season
-- itself, which nothing else does once `leagues.starts_on` has been overwritten by
-- the next one.
-- -----------------------------------------------------------------------------

create table if not exists league_seasons (
  league_id          uuid not null references leagues(id) on delete cascade,
  season             int  not null check (season >= 1),

  -- The calendar date day 1 of *this* season fell on, in the league's timezone. A
  -- copy of what `leagues.starts_on` said while this season was the current one.
  starts_on          date,
  started_at         timestamptz,
  finished_at        timestamptz,

  -- Null for a season still being played, and for one abandoned without a final.
  champion_member_id uuid references league_members(id) on delete set null,

  -- How much of it there was, so the board can say "14 days, 10 match days" without
  -- counting rows that a later season has since joined in the same table.
  days               int,
  match_days         int,

  created_at         timestamptz not null default now(),

  primary key (league_id, season)
);

comment on table league_seasons is
  'One row per season a league has played. The honours board of docs/01 section 7 point 1.';

create index if not exists league_seasons_champion_idx
  on league_seasons (champion_member_id)
  where champion_member_id is not null;

-- -----------------------------------------------------------------------------
-- 3. The Season Pack
--
-- docs/01 section 7 point 5: "a Season Pack is granted to every manager: guaranteed
-- Epic-or-better player card." `floor_band` is already how 0004 expresses a
-- guarantee, so this is one card with the floor set and nothing else new.
--
-- `is_active = false` is what makes it unbuyable rather than a price nobody can pay.
-- Both /api/pack/shop and /api/pack/buy filter on `is_active`, so it cannot be seen
-- or bought; /api/gifts/open looks the type up by key without that filter, which is
-- exactly the asymmetry a gift-only pack needs. Price is 0 for the same reason it is
-- 0 on the daily pack: nothing is ever charged for it.
--
-- The weights are the daily pack's, redistributed across the three bands that can
-- still come up once the Epic floor has eaten the bottom two. An Icon stays rare
-- enough to be a story.
-- -----------------------------------------------------------------------------

insert into pack_types (key, name, blurb, price, slots, one_per_role, weights, floor_band, max_band, daily_limit, sort, is_active)
values
  ('SEASON', 'Season pack',
   'For finishing a season. One player, Epic at worst.',
   0, 1, false,
   '{"EPIC":72,"LEGENDARY":24,"ICON":4}'::jsonb,
   'EPIC', null, null, 60, false)
on conflict (key) do update set
  name = excluded.name,
  blurb = excluded.blurb,
  price = excluded.price,
  slots = excluded.slots,
  one_per_role = excluded.one_per_role,
  weights = excluded.weights,
  floor_band = excluded.floor_band,
  max_band = excluded.max_band,
  daily_limit = excluded.daily_limit,
  sort = excluded.sort,
  is_active = excluded.is_active;

-- -----------------------------------------------------------------------------
-- 4. Row-level security
--
-- A member reads their league's honours. Nobody writes: finishing a season and
-- starting the next one both go through Nitro routes holding the service-role key,
-- which is the same rule every other league table follows and for the same reason —
-- a client that could insert a `league_seasons` row could award itself a trophy.
-- -----------------------------------------------------------------------------

alter table league_seasons enable row level security;

drop policy if exists league_seasons_select_same on league_seasons;
create policy league_seasons_select_same on league_seasons
  for select using (public.is_league_member(league_id));
