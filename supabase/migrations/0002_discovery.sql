-- =============================================================================
-- LOM v1 — discovery: a share code per manager, and who has found whom
--
-- Forward-only. Run after 0001_init.sql.
--
-- Why a share code and not the handle. The handle is derived from the email local
-- part, so `sayahkhalil` is guessable from an address and enumerable by anyone who
-- can type. A code is the thing you choose to hand out: eight characters, no
-- meaning, useless to guess (32^8 ≈ 1.1e12), and revocable later by regenerating it
-- without renaming the manager.
--
-- Crockford's base32 alphabet, minus nothing: 0-9 and A-Z without I, L, O and U. The
-- excluded letters are the ones people mistype (I/1, L/1, O/0) or that spell words by
-- accident. server/utils — shared/shareCode.ts — maps those lookalikes back on input,
-- so a code read off a phone screen and typed with an O still resolves.
--
-- Discovery is deliberately one-directional and explicit: nothing lists managers, and
-- nothing surfaces a manager you have not been given the code for. `discoveries` is
-- the seeker's own address book, which is why it hangs off the seeker and is readable
-- only by them.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. profiles.share_code
-- -----------------------------------------------------------------------------

alter table profiles add column if not exists share_code text;

comment on column profiles.share_code is
  'Eight Crockford base32 characters. Shown grouped as XXXX-XXXX; stored ungrouped.';

-- gen_random_bytes comes from pgcrypto, created in 0001. 256 is divisible by 32, so
-- the modulo is unbiased — random() would do, but there is no reason to hand out a
-- code that is cheaper to predict than the bytes cost.
--
-- `extensions` is in the search_path because Supabase installs pgcrypto there, not in
-- public, and pinning a security-definer function to `public` alone — which is the
-- right instinct, since an unpinned one resolves names against whatever the caller
-- has in front — then hides gen_random_bytes from it. A plain Postgres with pgcrypto
-- in public still works: a schema named in search_path that does not exist is
-- skipped, not an error.
create or replace function public.gen_share_code()
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
    for i in 1..8 loop
      candidate := candidate || substr(alphabet, 1 + (get_byte(gen_random_bytes(1), 0) % 32), 1);
    end loop;
    exit when not exists (select 1 from profiles where share_code = candidate);
  end loop;
  return candidate;
end;
$$;

-- A column default cannot see the table it must stay unique against, so the code is
-- minted in a BEFORE INSERT trigger. It sits on `profiles` rather than inside
-- handle_new_user() because two paths insert profiles: that trigger, and
-- ensureProfile() in server/utils/auth.ts healing an account the trigger missed.
create or replace function public.profiles_set_share_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.share_code is null then
    new.share_code := public.gen_share_code();
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_share_code on profiles;
create trigger profiles_share_code
  before insert on profiles
  for each row execute function public.profiles_set_share_code();

-- Backfill, one row per statement. A single `update ... set share_code =
-- gen_share_code()` would run every call against the statement's start snapshot, so
-- the rows it has already written would be invisible to the uniqueness check inside
-- the function and two managers could come out with the same code.
do $$
declare
  r record;
begin
  for r in select id from profiles where share_code is null loop
    update profiles set share_code = public.gen_share_code() where id = r.id;
  end loop;
end;
$$;

alter table profiles alter column share_code set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_share_code_shape'
  ) then
    alter table profiles add constraint profiles_share_code_shape
      check (share_code ~ '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$');
  end if;
end;
$$;

create unique index if not exists profiles_share_code_key on profiles (share_code);

-- -----------------------------------------------------------------------------
-- 2. Discoveries — the seeker's address book
-- -----------------------------------------------------------------------------

create table if not exists discoveries (
  seeker_id uuid not null references profiles(id) on delete cascade,
  found_id  uuid not null references profiles(id) on delete cascade,
  found_at  timestamptz not null default now(),
  primary key (seeker_id, found_id),
  check (seeker_id <> found_id)
);

comment on table discoveries is
  'One row per manager a seeker has found by code. Written by /api/discovery/*, never by the client.';

create index if not exists discoveries_seeker_idx
  on discoveries (seeker_id, found_at desc);

-- -----------------------------------------------------------------------------
-- 3. Row-level security
--
-- Same shape as 0001: the client reads its own rows and writes nothing. Resolving a
-- code reads another manager's profile and card count, which no anon-key policy
-- allows on purpose — it goes through a Nitro route holding the service-role key, so
-- the only way to see a stranger's collection is to present their code.
-- -----------------------------------------------------------------------------

alter table discoveries enable row level security;

drop policy if exists discoveries_select_own on discoveries;
create policy discoveries_select_own on discoveries
  for select to authenticated using (seeker_id = auth.uid());

drop policy if exists discoveries_delete_own on discoveries;
create policy discoveries_delete_own on discoveries
  for delete to authenticated using (seeker_id = auth.uid());
