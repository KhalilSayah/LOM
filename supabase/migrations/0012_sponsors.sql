-- =============================================================================
-- 0012 — Sponsors
--
-- Forward-only and re-runnable. Run in the Supabase SQL editor, or:
--   supabase db push
--
-- A sponsor is a contract with a demand attached. Three starters from the LCK,
-- nobody above Epic, win inside half an hour — meet it and the bonus pays, miss
-- it and you still collect the appearance fee. The money is the reason to sign
-- one; the demand is the reason signing is interesting, because two slots mean
-- the contracts you hold are a statement about how you intend to build and
-- draft. A sponsor that paid the same whatever you fielded would be a number
-- going up on its own.
--
-- docs/00 section 6 puts sponsorships in the management layer, out of scope for
-- v1. That was the right call while the match loop paid nothing at all; with
-- 0011 paying matches, a second faucet with a condition on it is what stops the
-- economy being "open packs, pull duplicates, buy packs". docs/12 is the spec
-- this migration implements.
--
-- Demands are stored as data and evaluated in shared/sponsors.ts, which is also
-- where their English comes from — a label column beside the demand would be a
-- second source of truth that drifts the first time a threshold is tuned here.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The catalogue
--
-- Fictional brands, on purpose and permanently. A real sponsor's name on a card
-- is a trademark problem the card catalogue does not have (its players and
-- teams are factual record), and inventing them means the terms can be whatever
-- the game needs. Same argument docs/02 section 2.6 makes for coaches being
-- archetypes rather than real people.
-- -----------------------------------------------------------------------------

create table if not exists sponsor_definitions (
  key            text primary key,
  name           text not null,
  blurb          text,
  tier           text not null check (tier in ('COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON')),

  -- Paid once, when the contract is signed into a slot. The moment of signing
  -- should feel like something.
  signing_bonus  int not null default 0 check (signing_bonus >= 0),
  -- The appearance fee: paid for every match played with this sponsor signed.
  base_payout    int not null default 0 check (base_payout >= 0),
  -- Paid on top when the demand is met.
  bonus_payout   int not null default 0 check (bonus_payout >= 0),

  -- { kind: 'REGION', region: 'LCK', min: 3 } and friends — see shared/sponsors.ts.
  demand         jsonb not null default '{"kind":"NONE"}'::jsonb,

  -- Brand colour, for the contract card. Presentation only.
  accent         text,

  sort           int not null default 0,
  is_active      boolean not null default true
);

comment on table sponsor_definitions is
  'Fictional sponsor brands and their terms. Demands are evaluated by shared/sponsors.ts.';

insert into sponsor_definitions (key, name, blurb, tier, signing_bonus, base_payout, bonus_payout, demand, accent, sort)
values
  -- COMMON — small money, soft terms. Somebody has to sponsor a team nobody watches.
  ('PITCHSIDE', 'Pitchside Print',
   'A local printer who just wants the logo on the jersey. No conditions, no questions.',
   'COMMON', 50, 28, 32, '{"kind":"NONE"}'::jsonb, '#7c8aa0', 10),

  ('DAWNBREAK', 'Dawnbreak Coffee',
   'They pay for winners. Lose and you still get the coffee.',
   'COMMON', 60, 20, 42, '{"kind":"WIN"}'::jsonb, '#8a5a3c', 20),

  ('SABRE', 'Sabre Seating',
   'Gaming chairs. They want highlights, which means they want kills.',
   'COMMON', 60, 25, 38, '{"kind":"KILLS","min":18}'::jsonb, '#9a3b3b', 30),

  -- RARE — a real ask in exchange for real money.
  ('VANTAGE', 'Vantage Peripherals',
   'Mice and keyboards. Their marketing is built on teamfight clips.',
   'RARE', 120, 40, 82, '{"kind":"KILLS","min":25}'::jsonb, '#3f6f9a', 40),

  ('THRIFTWELL', 'Thriftwell Insurance',
   'Sensible people backing a sensible squad. Nobody flashy in the five.',
   'RARE', 120, 45, 95, '{"kind":"MAX_RARITY","rarity":"EPIC"}'::jsonb, '#4a7a5c', 50),

  ('HANBIT', 'Hanbit Telecom',
   'A Korean carrier. They sponsor Korean players, and they count.',
   'RARE', 150, 35, 130, '{"kind":"REGION","region":"LCK","min":3}'::jsonb, '#2f5fa8', 60),

  ('BAYLIGHT', 'Baylight Rideshare',
   'North American, loudly. Three from the LCS or the cheque is smaller.',
   'RARE', 150, 38, 125, '{"kind":"REGION","region":"LCS","min":3}'::jsonb, '#2f8a7a', 70),

  -- EPIC — the terms start shaping the draft.
  ('EMBERFALL', 'Emberfall Energy',
   'An energy drink that has never once sponsored a slow game.',
   'EPIC', 250, 50, 172, '{"kind":"KILLS","min":32}'::jsonb, '#c2561f', 80),

  ('PIXELFORGE', 'Pixelforge Displays',
   'Monitors sold on reaction time. They pay for a game that ends early.',
   'EPIC', 250, 55, 168, '{"kind":"FAST_WIN","minutes":30}'::jsonb, '#6b3fa0', 90),

  ('MERIDIAN', 'Meridian Bank',
   'European money for a European roster. Three of them, at least.',
   'EPIC', 280, 70, 160, '{"kind":"REGION","region":"LEC","min":3}'::jsonb, '#1f5f8a', 100),

  ('JADEPORT', 'Jadeport Logistics',
   'Shipping out of Shanghai. They would like the roster to reflect that.',
   'EPIC', 280, 62, 158, '{"kind":"REGION","region":"LPL","min":3}'::jsonb, '#b03a4a', 110),

  -- LEGENDARY — big money, and the demand is a way of playing rather than a stat.
  ('GRANITE', 'Granite Holdings',
   'They buy history. Field three players who actually played together.',
   'LEGENDARY', 500, 95, 275, '{"kind":"CORE","min":3}'::jsonb, '#8a7a4a', 120),

  ('VELODYNE', 'Velodyne Motors',
   'The underdog account. Keep the squad rating modest and they pay like a title sponsor.',
   'LEGENDARY', 500, 105, 255, '{"kind":"MAX_OVR","ovr":82}'::jsonb, '#1f3f6f', 130),

  -- ICON — one contract, and it asks for a collection rather than a lineup.
  ('SOLSTICE', 'Solstice Global',
   'A heritage campaign. Two starters from the old days, every time you play.',
   'ICON', 900, 150, 430, '{"kind":"SEASON_RANGE","from":2011,"to":2017,"min":2}'::jsonb, '#d8b064', 140)

on conflict (key) do update set
  name = excluded.name,
  blurb = excluded.blurb,
  tier = excluded.tier,
  signing_bonus = excluded.signing_bonus,
  base_payout = excluded.base_payout,
  bonus_payout = excluded.bonus_payout,
  demand = excluded.demand,
  accent = excluded.accent,
  sort = excluded.sort;

-- -----------------------------------------------------------------------------
-- 2. Contracts a manager holds
--
-- `slot` null means the contract is in the drawer: owned, unsigned, paying
-- nothing. A number means it is signed and live. The partial unique index is
-- what stops two contracts occupying one slot, and the range check is wider
-- than SPONSOR_SLOTS in shared/sponsors.ts on purpose, so raising the cap is a
-- constant rather than a migration.
-- -----------------------------------------------------------------------------

create table if not exists manager_sponsors (
  id             uuid primary key default gen_random_uuid(),
  profile_id     uuid not null references profiles(id) on delete cascade,
  sponsor_key    text not null references sponsor_definitions(key) on delete cascade,

  slot           int check (slot is null or slot between 0 and 3),

  credits_earned int not null default 0 check (credits_earned >= 0),
  matches_paid   int not null default 0 check (matches_paid >= 0),

  -- Matches played since this contract was last signed into a slot. A contract
  -- runs a term (SPONSOR_TERM in shared/sponsors.ts) before it can be released
  -- for nothing, because a demand you can swap out of between matches is not a
  -- demand — you would simply sign whichever brand happens to match the five
  -- you already intended to field. Leaving early is a buy-out, priced at the
  -- signing bonus.
  matches_since_signed int not null default 0 check (matches_since_signed >= 0),

  acquired_at    timestamptz not null default now(),
  signed_at      timestamptz,

  -- One contract per brand per manager. A brand you already hold cannot be
  -- signed twice, so a second pull pays out instead (SPONSOR_DUPLICATE_CREDITS).
  unique (profile_id, sponsor_key)
);

-- Re-runnable for a database that was created from an earlier copy of this file.
alter table manager_sponsors
  add column if not exists matches_since_signed int not null default 0;

create unique index if not exists manager_sponsors_slot_idx
  on manager_sponsors (profile_id, slot)
  where slot is not null;

create index if not exists manager_sponsors_profile_idx
  on manager_sponsors (profile_id, acquired_at desc);

comment on column manager_sponsors.slot is
  'null = owned but unsigned. A number = live, and paying out on every match.';

-- -----------------------------------------------------------------------------
-- 3. Row-level security
--
-- The catalogue is public — terms you cannot read before signing are not terms.
-- Contracts are readable by their owner and writable by nobody: signing goes
-- through a Nitro route with the service-role key, because a client that could
-- insert its own manager_sponsors row could sign the Icon contract for free.
-- -----------------------------------------------------------------------------

alter table sponsor_definitions enable row level security;
alter table manager_sponsors    enable row level security;

drop policy if exists sponsor_definitions_select_all on sponsor_definitions;
create policy sponsor_definitions_select_all on sponsor_definitions
  for select using (true);

drop policy if exists manager_sponsors_select_own on manager_sponsors;
create policy manager_sponsors_select_own on manager_sponsors
  for select using (profile_id = auth.uid());
