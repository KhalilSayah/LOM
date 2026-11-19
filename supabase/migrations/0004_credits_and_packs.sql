-- =============================================================================
-- 0004 — Credits, and packs you can choose between
--
-- Forward-only and re-runnable. Run in the Supabase SQL editor, or:
--   supabase db push
--
-- Two things arrive together because neither is much use alone: a soft currency
-- (docs/01 section 5 calls it Credits) and more than one kind of pack to spend
-- it on. docs/02 section 8 left multi-slot packs as an open question; this
-- settles it, so docs/02 section 5 is rewritten alongside this migration.
--
-- The odds live in a table rather than in code. Pack pricing and drop rates are
-- the numbers most likely to be wrong on the first try, and a balance pass
-- should be an UPDATE in the SQL editor, not a deploy.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Credits
--
-- `profiles.credits` is a cached balance and `credit_ledger` is the truth, which
-- is the split docs/07 section 4 asks for. Every movement writes a ledger row
-- carrying the balance it produced, so a disagreement between the two is
-- visible rather than silent.
-- -----------------------------------------------------------------------------

alter table profiles
  add column if not exists credits int not null default 0 check (credits >= 0);

comment on column profiles.credits is
  'Cached balance. credit_ledger is authoritative; change it only through grant_credits().';

create table if not exists credit_ledger (
  id            bigserial primary key,
  profile_id    uuid not null references profiles(id) on delete cascade,
  delta         int not null check (delta <> 0),
  reason        text not null,
  ref_id        uuid,
  balance_after int not null check (balance_after >= 0),
  created_at    timestamptz not null default now()
);

create index if not exists credit_ledger_profile_idx
  on credit_ledger (profile_id, created_at desc);

/**
 * The only supported way to move Credits.
 *
 * Takes the profile row for update first, so two concurrent spends cannot both
 * read the same balance and both succeed. Refuses to overdraw rather than
 * clamping at zero: a spend that cannot be paid for must fail loudly, or a pack
 * gets opened for free.
 *
 * search_path includes `extensions` because Supabase installs pgcrypto there,
 * and a security definer function pinned to `public` alone cannot see it.
 */
create or replace function public.grant_credits(
  p_profile uuid,
  p_delta   int,
  p_reason  text default 'GRANT',
  p_ref     uuid default null
)
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  new_balance int;
begin
  if p_delta = 0 then
    raise exception 'grant_credits: delta of zero does nothing';
  end if;

  select credits into new_balance from profiles where id = p_profile for update;
  if not found then
    raise exception 'grant_credits: no profile %', p_profile;
  end if;

  new_balance := new_balance + p_delta;
  if new_balance < 0 then
    raise exception 'grant_credits: balance % cannot pay %', new_balance - p_delta, p_delta;
  end if;

  update profiles set credits = new_balance where id = p_profile;

  insert into credit_ledger (profile_id, delta, reason, ref_id, balance_after)
  values (p_profile, p_delta, p_reason, p_ref, new_balance);

  return new_balance;
end;
$$;

/**
 * The same thing by handle, because handing someone Credits from the SQL editor
 * should not mean looking up a uuid first:
 *
 *   select grant_credits_by_handle('khalil', 5000, 'FOUNDER');
 */
create or replace function public.grant_credits_by_handle(
  p_handle text,
  p_delta  int,
  p_reason text default 'GRANT'
)
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  target uuid;
begin
  select id into target from profiles where handle = lower(p_handle);
  if target is null then
    raise exception 'grant_credits_by_handle: no manager with handle %', p_handle;
  end if;
  return grant_credits(target, p_delta, p_reason, null);
end;
$$;

-- Granting is an operator action, run as the service role or from the SQL
-- editor. No client ever calls these.
revoke execute on function public.grant_credits(uuid, int, text, uuid) from anon, authenticated;
revoke execute on function public.grant_credits_by_handle(text, int, text) from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Pack types
--
-- `weights` is {band: weight} and does not have to sum to anything; the roll
-- normalises it. `floor_band` guarantees one slot at that band or better.
-- `max_band` caps what the pack can produce at all, which is what makes a cheap
-- pack cheap. `one_per_role` fills the slots one per lane instead of at random.
-- -----------------------------------------------------------------------------

create table if not exists pack_types (
  key          text primary key,
  name         text not null,
  blurb        text,
  price        int not null check (price >= 0),
  slots        int not null check (slots between 1 and 10),
  one_per_role boolean not null default false,
  weights      jsonb not null,
  floor_band   text check (floor_band in ('COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON')),
  max_band     text check (max_band in ('COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON')),
  daily_limit  int check (daily_limit is null or daily_limit > 0),
  sort         int not null default 0,
  is_active    boolean not null default true
);

comment on table pack_types is
  'Pack prices and drop rates, as data. A balance pass is an UPDATE here, not a deploy.';

-- A pack with five slots and one_per_role covers all five lanes, so it cannot
-- have fewer slots than there are roles.
alter table pack_types drop constraint if exists pack_types_role_slots;
alter table pack_types add constraint pack_types_role_slots
  check (not one_per_role or slots = 5);

insert into pack_types (key, name, blurb, price, slots, one_per_role, weights, floor_band, max_band, daily_limit, sort)
values
  ('DAILY', 'Daily pack',
   'One card, free, once a day.',
   0, 1, false,
   '{"COMMON":52,"RARE":30,"EPIC":13,"LEGENDARY":4.4,"ICON":0.6}'::jsonb,
   null, null, 1, 10),

  ('SCOUTING', 'Scouting pack',
   'Three players. Nobody famous — this is squad depth, not a lottery ticket.',
   150, 3, false,
   '{"COMMON":74,"RARE":22,"EPIC":4}'::jsonb,
   null, 'EPIC', null, 20),

  ('SIGNING', 'Signing pack',
   'Five players, one for every lane. Mostly ordinary, but you walk away with a whole squad.',
   400, 5, true,
   '{"COMMON":78,"RARE":18,"EPIC":3.6,"LEGENDARY":0.4}'::jsonb,
   null, 'LEGENDARY', null, 30),

  ('STANDARD', 'Standard pack',
   'One card, the same odds as the daily pack. The only cheap way to an Icon.',
   300, 1, false,
   '{"COMMON":52,"RARE":30,"EPIC":13,"LEGENDARY":4.4,"ICON":0.6}'::jsonb,
   null, null, 2, 40),

  ('LEGACY', 'Legacy pack',
   'Three cards, one of them Legendary at worst.',
   2500, 3, false,
   '{"COMMON":40,"RARE":30,"EPIC":22,"LEGENDARY":7,"ICON":1}'::jsonb,
   'LEGENDARY', null, null, 50)
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
  sort = excluded.sort;

-- -----------------------------------------------------------------------------
-- 3. Openings
--
-- pack_claims stays exactly as it is: it is the lock that makes the free daily
-- pack once-a-day, and nothing about buying packs should weaken that. What it
-- cannot do is hold five cards, so the cards themselves move here.
-- -----------------------------------------------------------------------------

create table if not exists pack_openings (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references profiles(id) on delete cascade,
  pack_type     text not null references pack_types(key),
  pack_day      date,
  credits_spent int not null default 0 check (credits_spent >= 0),
  opened_at     timestamptz not null default now()
);

comment on column pack_openings.pack_day is
  'Set for packs that are limited per day, so the limit can be counted without a scan.';

create index if not exists pack_openings_profile_idx
  on pack_openings (profile_id, opened_at desc);
create index if not exists pack_openings_limit_idx
  on pack_openings (profile_id, pack_type, pack_day);

create table if not exists pack_opening_cards (
  id                 uuid primary key default gen_random_uuid(),
  opening_id         uuid not null references pack_openings(id) on delete cascade,
  slot               int not null check (slot >= 0),
  card_definition_id uuid not null references card_definitions(id) on delete cascade,
  rarity             text not null check (rarity in ('COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICON')),
  was_duplicate      boolean not null default false,
  xp_awarded         int not null default 0,
  credits_awarded    int not null default 0,
  unique (opening_id, slot)
);

create index if not exists pack_opening_cards_opening_idx
  on pack_opening_cards (opening_id, slot);

-- Link a daily claim to the opening that settled it, so the two stories agree.
alter table pack_claims
  add column if not exists opening_id uuid references pack_openings(id) on delete set null;

-- -----------------------------------------------------------------------------
-- 4. Row-level security
--
-- Same shape as everything else: a manager reads their own rows and writes
-- none of them. Buying a pack goes through a Nitro route holding the
-- service-role key, because a client that could insert its own pack_openings
-- could open a Legacy pack for nothing.
-- -----------------------------------------------------------------------------

alter table credit_ledger      enable row level security;
alter table pack_types         enable row level security;
alter table pack_openings      enable row level security;
alter table pack_opening_cards enable row level security;

drop policy if exists credit_ledger_select_own on credit_ledger;
create policy credit_ledger_select_own on credit_ledger
  for select using (profile_id = auth.uid());

-- The shop is public: prices and odds are not a secret, and docs/02 section 5.2
-- says pity and odds are shown because hiding them is just anxiety.
drop policy if exists pack_types_select_all on pack_types;
create policy pack_types_select_all on pack_types
  for select using (true);

drop policy if exists pack_openings_select_own on pack_openings;
create policy pack_openings_select_own on pack_openings
  for select using (profile_id = auth.uid());

drop policy if exists pack_opening_cards_select_own on pack_opening_cards;
create policy pack_opening_cards_select_own on pack_opening_cards
  for select using (
    exists (
      select 1 from pack_openings o
      where o.id = pack_opening_cards.opening_id
        and o.profile_id = auth.uid()
    )
  );
