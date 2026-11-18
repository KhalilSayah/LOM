# 07 — Data Model

Postgres 15 on Supabase. All identifiers `snake_case`, all primary keys `uuid` unless noted,
all timestamps `timestamptz`. Migrations live in `packages/db/migrations`, forward-only.

## 1. A decision up front: collections are per-league

`manager_cards` hangs off `league_members`, not off `profiles`.

Each league membership has its own collection, its own credits and its own starter squad. The
reasons:

- Starter squads are granted at league start with a no-duplicate-within-league constraint; a
  global collection makes that meaningless.
- Daily packs are a per-league-day entitlement. A global collection would let someone in four
  leagues out-collect a friend four to one.
- A league pins a `catalogue_version` ([03 section 9](03-data-pipeline.md)); a global
  collection would have to span versions.

The cost is that joining a second league means starting over. For a friend-group product that
is correct — each league is its own self-contained season story. A cross-league "trophy
cabinet" on the profile covers the vanity need without touching power.

## 2. Catalogue (written only by the pipeline)

```sql
create table catalogue_versions (
  id               uuid primary key default gen_random_uuid(),
  semver           text not null unique,            -- '2026.11.1'
  built_at         timestamptz not null default now(),
  pipeline_git_sha text not null,
  source_hashes    jsonb not null,                  -- { "oe_2024": "sha256:...", ... }
  card_count       int  not null,
  status           text not null check (status in ('building','validated','live','archived')),
  validation       jsonb                            -- anchor diffs, cohort sizes
);

create table champions (
  key           text primary key,                   -- 'Azir' (Data Dragon id)
  name          text not null,
  tags          text[] not null,                    -- Data Dragon tags
  archetype     text not null check (archetype in
                  ('LANE_BULLY','SKIRMISHER','ASSASSIN','TANK','UTILITY','SCALING_CARRY')),
  native_roles  text[] not null,                    -- ['MID']
  flex_roles    text[] not null default '{}',       -- ['TOP'] where >=10% pro presence
  icon_path     text,
  splash_path   text
);

create table card_definitions (
  id                    uuid primary key default gen_random_uuid(),
  catalogue_version_id  uuid not null references catalogue_versions(id),
  card_key              text not null,              -- 'faker-2024'
  kind                  text not null default 'PLAYER'
                        check (kind in ('PLAYER','COACH')),
  player_uid            text,
  player_name           text not null,
  real_name             text,
  season                int,
  team                  text,
  region                text,
  role                  text check (role in ('TOP','JNG','MID','BOT','SUP')),
  ovr                   int  not null check (ovr between 40 and 99),
  sub_stats             jsonb not null,             -- {laning,teamfight,mechanics,macro,vision,consistency}
  rarity                text not null check (rarity in
                          ('COMMON','RARE','EPIC','LEGENDARY','ICON')),
  accolades             jsonb not null default '[]',
  season_summary        jsonb not null default '{}',-- games, kda, gd15, dpm ... for the card back
  provenance            jsonb not null,             -- sources, row counts, pipeline version
  portrait_path         text,                       -- null => generated avatar
  coach_effect          jsonb,                      -- only when kind = 'COACH'
  unique (catalogue_version_id, card_key)
);

create index on card_definitions (catalogue_version_id, role, ovr desc);
create index on card_definitions (catalogue_version_id, rarity);
create index on card_definitions using gin (to_tsvector('simple', player_name));

create table card_champion_pool (
  card_definition_id uuid not null references card_definitions(id) on delete cascade,
  champion_key       text not null references champions(key),
  games              int  not null,
  winrate            numeric(4,3) not null,
  mastery            int  not null check (mastery between 0 and 100),
  primary key (card_definition_id, champion_key)
);

create index on card_champion_pool (champion_key, mastery desc);
```

## 3. Game state

```sql
create table profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  handle       text not null unique check (handle ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null,
  avatar_url   text,
  created_at   timestamptz not null default now()
);

create table leagues (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  owner_id             uuid not null references profiles(id),
  invite_code          text not null unique,          -- 6 chars, A-Z2-9, ambiguity-free
  timezone             text not null,                 -- IANA, 'Europe/Paris'
  match_hour           time not null,                 -- league-local
  season_length_days   int  not null default 14,
  catalogue_version_id uuid not null references catalogue_versions(id),
  rules_preset         text not null default 'modern',
  status               text not null default 'forming'
                       check (status in ('forming','active','paused','finished')),
  paused_until         date,
  created_at           timestamptz not null default now()
);

create table league_members (
  id          uuid primary key default gen_random_uuid(),
  league_id   uuid not null references leagues(id) on delete cascade,
  profile_id  uuid not null references profiles(id) on delete cascade,
  team_name   text not null,
  credits     int  not null default 0 check (credits >= 0),
  joined_at   timestamptz not null default now(),
  unique (league_id, profile_id)
);

create table seasons (
  id          uuid primary key default gen_random_uuid(),
  league_id   uuid not null references leagues(id) on delete cascade,
  index       int  not null,                          -- 1, 2, 3 ...
  status      text not null check (status in ('active','finished')),
  started_on  date not null,
  current_day int  not null default 1,
  champion_member_id uuid references league_members(id),
  unique (league_id, index)
);

create table fixtures (
  id               uuid primary key default gen_random_uuid(),
  season_id        uuid not null references seasons(id) on delete cascade,
  day_index        int  not null,
  stage            text not null default 'REGULAR'
                   check (stage in ('REGULAR','SEMI','FINAL','THIRD','EXHIBITION','GHOST')),
  blue_member_id   uuid not null references league_members(id),
  red_member_id    uuid references league_members(id),   -- null => Ghost opponent
  scheduled_at     timestamptz not null,
  status           text not null default 'scheduled'
                   check (status in ('scheduled','lobby_open','drafting',
                                     'simulating','ready','final','voided')),
  rescheduled_from timestamptz,
  created_at       timestamptz not null default now(),
  unique (season_id, day_index, blue_member_id)
);

create index on fixtures (status, scheduled_at);
create index on fixtures (season_id, day_index);
```

## 4. Collection

```sql
create table manager_cards (
  id                  uuid primary key default gen_random_uuid(),
  league_member_id    uuid not null references league_members(id) on delete cascade,
  card_definition_id  uuid not null references card_definitions(id),
  level               int  not null default 1 check (level between 1 and 10),
  xp                  int  not null default 0,
  acquired_at         timestamptz not null default now(),
  source              text not null check (source in ('STARTER','PACK','SEASON_REWARD','MIGRATION')),
  unique (league_member_id, card_definition_id)
);

-- mastery granted by tokens, added on top of the catalogue pool value, capped at 100 in code
create table manager_card_mastery (
  manager_card_id uuid not null references manager_cards(id) on delete cascade,
  champion_key    text not null references champions(key),
  bonus           int  not null default 0 check (bonus between 0 and 100),
  primary key (manager_card_id, champion_key)
);

create table manager_items (
  id               uuid primary key default gen_random_uuid(),
  league_member_id uuid not null references league_members(id) on delete cascade,
  kind             text not null check (kind in ('MASTERY_TOKEN','COACH')),
  payload          jsonb not null,     -- {role:'MID'} | {coachCardKey:'draft-specialist'}
  quantity         int  not null default 1 check (quantity >= 0),
  consumed_at      timestamptz
);

create table pity_counters (
  league_member_id uuid primary key references league_members(id) on delete cascade,
  since_legendary  int not null default 0,
  since_icon       int not null default 0
);

create table pack_entitlements (
  id               uuid primary key default gen_random_uuid(),
  league_member_id uuid not null references league_members(id) on delete cascade,
  day_index        int  not null,
  source           text not null check (source in ('DAILY','PURCHASED','SEASON','REROLL')),
  granted_at       timestamptz not null default now(),
  expires_at       timestamptz,
  claimed_at       timestamptz,
  result           jsonb                 -- the rolled outcome, written at claim time
);

create index on pack_entitlements (league_member_id, claimed_at);

create table credit_ledger (
  id               bigserial primary key,
  league_member_id uuid not null references league_members(id) on delete cascade,
  delta            int  not null,
  reason           text not null,        -- 'MATCH_PLAYED','MATCH_WON','PACK_PURCHASE',...
  ref_id           uuid,
  created_at       timestamptz not null default now()
);
```

`credits` on `league_members` is a cached balance; the ledger is the truth. A nightly check
reconciles them and logs a discrepancy rather than silently correcting it.

## 5. Lineups, drafts, matches

```sql
create table lineups (
  id               uuid primary key default gen_random_uuid(),
  fixture_id       uuid not null references fixtures(id) on delete cascade,
  league_member_id uuid not null references league_members(id) on delete cascade,
  slots            jsonb not null,  -- {"TOP":"<manager_card_id>", ... all five}
  strategy         text not null default 'STANDARD'
                   check (strategy in ('STANDARD','AGGRESSIVE','SCALING')),
  coach_item_id    uuid references manager_items(id),
  locked_at        timestamptz,
  unique (fixture_id, league_member_id)
);

create table drafts (
  fixture_id           uuid primary key references fixtures(id) on delete cascade,
  action_index         int  not null default 0,        -- 0..20
  deadline_at          timestamptz,
  blue_bonus_ms        int  not null default 60000,
  red_bonus_ms         int  not null default 60000,
  blue_present         boolean not null default false,
  red_present          boolean not null default false,
  started_at           timestamptz,
  completed_at         timestamptz
);

create table draft_actions (
  fixture_id   uuid not null references fixtures(id) on delete cascade,
  action_index int  not null,
  team         text not null check (team in ('BLUE','RED')),
  kind         text not null check (kind in ('BAN','PICK')),
  champion_key text references champions(key),        -- null = ban declined
  slot         text check (slot in ('TOP','JNG','MID','BOT','SUP')),
  actor        text not null check (actor in ('HUMAN','AUTO_TIMEOUT','AUTO_ABSENT','AUTO_REQUESTED')),
  created_at   timestamptz not null default now(),
  primary key (fixture_id, action_index)
);

create table matches (
  fixture_id    uuid primary key references fixtures(id) on delete cascade,
  sim_version   text not null,
  seed          text not null,
  winner        text not null check (winner in ('BLUE','RED')),
  game_length   int  not null,                        -- seconds
  events        jsonb not null,                       -- SimEvent[]
  timeline      jsonb not null,                       -- 60s samples
  simulated_at  timestamptz not null default now(),
  blue_viewed_at timestamptz,
  red_viewed_at  timestamptz
);

create table match_player_stats (
  fixture_id         uuid not null references matches(fixture_id) on delete cascade,
  team               text not null check (team in ('BLUE','RED')),
  slot               text not null check (slot in ('TOP','JNG','MID','BOT','SUP')),
  manager_card_id    uuid references manager_cards(id),
  card_definition_id uuid not null references card_definitions(id),
  champion_key       text not null references champions(key),
  eff_rating         numeric(5,2) not null,
  kills int not null, deaths int not null, assists int not null,
  cs int not null, gold int not null, damage int not null,
  vision_score int not null, kill_participation numeric(4,3) not null,
  grade text not null check (grade in ('S+','S','A','B','C','D')),
  primary key (fixture_id, team, slot)
);
```

**Event-log size.** A typical match produces 200-400 events; at roughly 250 bytes each that is
50-100 KB of JSONB, which Postgres stores TOASTed and compressed without complaint. A guard in
the write path logs a warning above 256 KB; if that becomes routine, move `events` to Supabase
Storage as gzipped JSON and keep a pointer here. Do not pre-optimise it.

## 6. Standings

A view, not a table — recomputed on read, trivially cheap at this scale:

```sql
create view standings as
select
  f.season_id,
  m.id as league_member_id,
  count(*) filter (where res.won)                               as wins,
  count(*) filter (where not res.won)                           as losses,
  3 * count(*) filter (where res.won)                           as points,
  sum(res.time_diff)                                            as game_time_diff,
  sum(res.kills)                                                as kills
from ...   -- fixtures joined to matches, unpivoted per side, stage = 'REGULAR'
group by f.season_id, m.id;
```

Tiebreak ordering (points, head-to-head, game-time differential, kills, seeded coin flip) is
applied in `@lom/core` rather than in SQL, because head-to-head is not expressible cleanly in
a single ordering and the logic must be identical in the UI preview and the playoff seeding.

## 7. Row-level security

RLS is enabled on **every** table. The client uses the anon key; the Nitro server uses the
service-role key and bypasses RLS entirely.

| Table | Client policy |
|---|---|
| `profiles` | select own row; select rows of profiles sharing a league; update own |
| `leagues` | select where a membership exists for `auth.uid()` |
| `league_members` | select where same league as a membership of `auth.uid()` |
| `seasons`, `fixtures` | select via league membership |
| `manager_cards`, `manager_card_mastery`, `manager_items`, `pack_entitlements`, `pity_counters`, `credit_ledger` | select/`update` **own membership only** |
| `lineups` | select own; **never** the opponent's (the draft endpoint reveals it at the right moment) |
| `drafts`, `draft_actions` | select via league membership; **no client insert or update** |
| `matches`, `match_player_stats` | select via league membership once `status in ('ready','final')` |
| `card_definitions`, `card_champion_pool`, `champions`, `catalogue_versions` | select where the catalogue version is the one pinned by a league the user belongs to |
| `raw_*`, `pipeline_runs`, `asset_licences`, `server_instances` | no client access |

The `lineups` policy is the sharp one: lineups become visible to the opponent only through the
draft state endpoint, which applies its own filtering ([05 section 2](05-draft-and-live-session.md)).
Keeping that out of RLS and in one audited code path is deliberate — the visibility rule is
time-dependent, and time-dependent RLS is how leaks happen.

Helper:

```sql
create function is_league_member(p_league uuid) returns boolean
language sql security definer stable as $$
  select exists (
    select 1 from league_members lm
    where lm.league_id = p_league and lm.profile_id = auth.uid()
  );
$$;
```

## 8. Pipeline tables

`raw_oe_player_rows`, `raw_oe_team_rows`, `raw_leaguepedia_players`, `raw_leaguepedia_results`,
`player_season_aggregates`, `pipeline_runs`, `asset_licences`. All in a separate `pipeline`
schema, all service-role only. Detailed in [03](03-data-pipeline.md).

## 9. Retention

Nothing in a league is ever deleted. Matches, event logs and collections persist across
seasons; a league can be archived (`status = 'finished'`) but stays readable. The only deletion
path is a user deleting their account, which cascades `profiles` and anonymises their
`league_members` rows to `"Former manager"` so other managers' match history stays intact.

## 10. Open questions

- **Per-league collections** are the right call for v1 but will be re-examined if people end up
  running back-to-back seasons in one league and wanting a fresh start without losing cards.
- **`events` as JSONB** vs Storage — revisit if median size exceeds ~150 KB.
- **Standings as a view** will need materialising if a league ever has hundreds of fixtures.
  Not a v1 concern.
- **Catalogue rows are duplicated per version.** ~10k cards x a few versions is harmless now;
  if version count grows, split immutable identity from per-version ratings.
