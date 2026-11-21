-- =============================================================================
-- 0019 — Economy integrity, banked daily packs, streaks and quests
--
-- Forward-only and re-runnable: every statement is guarded, so running this
-- file twice changes nothing the second time. Run it in the Supabase SQL editor.
-- Depends on 0001, 0004 and 0008. Works with or without 0011-0014 (the tables
-- those add are hardened only if they exist).
--
-- What it does, in order:
--
--   1. Closes the client write paths into the economy. A signed-in manager could
--      update every column of their own profile row (credits included), and the
--      Credits/gift functions were still executable by PUBLIC — `revoke ... from
--      anon, authenticated` does not remove the default PUBLIC grant, so any
--      client could call grant_credits() on itself through PostgREST.
--   2. Opens a pack in one transaction (lom_open_pack): spend, cards, duplicate
--      XP and Credits, pity and the claim/gift lock all commit together or not
--      at all. That is what makes a daily pack impossible to open twice and a
--      bought pack impossible to pay for without receiving.
--   3. Records which pack day a daily pack was opened on, so unclaimed packs can
--      bank (up to 3) and the login streak can be counted.
--   4. Quests: one row per claimed quest per period, and the function that pays
--      it exactly once.
--   5. A price/blurb fix for the Scouting pack (pity farming, see below).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Nobody writes their own economy rows
-- -----------------------------------------------------------------------------

-- profiles_update_own let a manager set their own credits, handle and share
-- code. No client code updates profiles (handle and display-name edits go
-- through a server route), so the policy and the privilege both go.
drop policy if exists profiles_update_own on public.profiles;

-- Row-level security already denies writes where no policy allows them; the
-- privileges are revoked as well so a future permissive policy cannot quietly
-- reopen any of these tables. The service role (server routes) is unaffected.
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'credit_ledger', 'collection_cards', 'pity_counters',
    'pack_claims', 'pack_types', 'pack_openings', 'pack_opening_cards',
    'pack_gifts', 'match_rewards', 'manager_sponsors', 'sponsor_definitions',
    'season_rewards', 'catalogue_versions', 'card_definitions', 'card_champion_pool'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke insert, update, delete, truncate on table public.%I from anon, authenticated', t);
    end if;
  end loop;
end;
$$;

-- Functions are executable by PUBLIC unless that grant is revoked by name.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.grant_credits(uuid, integer, text, uuid)',
    'public.grant_credits_by_handle(text, integer, text)',
    'public.grant_pack_gift(uuid, text, text, text, text)',
    'public.grant_pack_gift_by_handle(text, text, text, text, text)',
    'public.grant_welcome_pack(uuid)'
  ] loop
    if to_regprocedure(f) is not null then
      execute format('revoke all on function %s from public, anon, authenticated', f);
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Openings know what they settled
--
-- An opening points at the daily claim or the gift it paid out, and each of
-- those can be paid out by at most one opening. The unique indexes are the
-- backstop under the row locks in lom_open_pack.
-- -----------------------------------------------------------------------------

alter table pack_openings add column if not exists claim_id uuid references pack_claims(id) on delete set null;
alter table pack_openings add column if not exists gift_id  uuid references pack_gifts(id)  on delete set null;

create unique index if not exists pack_openings_claim_once on pack_openings (claim_id) where claim_id is not null;
create unique index if not exists pack_openings_gift_once  on pack_openings (gift_id)  where gift_id  is not null;

-- The pack day a daily pack was actually opened on. pack_day is the day the
-- pack belongs to, which differs from this when a banked pack is opened later.
-- The streak counts opened_day; banking counts pack_day.
alter table pack_claims add column if not exists opened_day date;
alter table pack_claims add column if not exists streak_bonus boolean not null default false;

create index if not exists pack_claims_opened_idx on pack_claims (profile_id, opened_day desc);

-- Before this migration a claim whose final update failed was left unsettled
-- even though its cards had been granted, and the next tap rolled it again.
-- Settle those against the opening that already paid out, so nothing re-rolls.
update pack_claims c
   set settled_at = o.opened_at,
       opening_id = o.id
  from pack_openings o
 where c.settled_at is null
   and o.profile_id = c.profile_id
   and o.pack_type = 'DAILY'
   and o.pack_day = c.pack_day;

update pack_claims set opened_day = pack_day
 where opened_day is null and settled_at is not null;

update pack_openings o
   set claim_id = c.id
  from pack_claims c
 where c.opening_id = o.id
   and o.claim_id is null
   and not exists (select 1 from pack_openings x where x.claim_id = c.id);

update pack_openings o
   set gift_id = g.id
  from pack_gifts g
 where g.opening_id = o.id
   and o.gift_id is null
   and not exists (select 1 from pack_openings x where x.gift_id = g.id);

-- -----------------------------------------------------------------------------
-- 3. Opening a pack, atomically
--
-- The server rolls the cards (a roll has no side effects) and hands the plan
-- here. Everything with a side effect happens inside this one function, under a
-- lock on the manager's profile row, so two openings by the same manager queue
-- up rather than interleave:
--
--   DAILY  reserve the (profile, pack_day) claim, refuse if already settled
--   BUY    check the per-day limit, spend the price
--   GIFT   refuse a gift that is already open
--
-- then grant every slot (a card already held becomes XP plus Credits, decided
-- here against the collection as it is now, not as the roll saw it), advance
-- pity per card, and settle the claim or gift. Either all of it commits or none.
--
-- p_plan is [{slot, card, band, dup_xp, dup_credits}, ...]. The XP curve below
-- (400 a level, cap 10, 399 at the cap) mirrors applyXp in server/utils/roll.ts.
--
-- Errors the server maps to messages: 'lom:no_pack', 'lom:limit', 'lom:funds'.
-- -----------------------------------------------------------------------------

create or replace function public.lom_open_pack(
  p_profile    uuid,
  p_source     text,
  p_pack_type  text,
  p_plan       jsonb,
  p_pack_day   date default null,
  p_opened_day date default null,
  p_gift       uuid default null,
  p_bonus      boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_pack     pack_types%rowtype;
  v_claim_id uuid;
  v_settled  timestamptz;
  v_gift     pack_gifts%rowtype;
  v_opening  uuid;
  v_price    int := 0;
  v_used     int;
  v_slot     jsonb;
  v_card     uuid;
  v_band     text;
  v_held     collection_cards%rowtype;
  v_dup      boolean;
  v_gain     int;
  v_credits  int;
  v_level    int;
  v_xp       int;
  v_earned   int := 0;
  v_balance  int;
  v_cards    jsonb := '[]'::jsonb;
  v_first    jsonb;
  v_since_l  int;
  v_since_i  int;
  v_opened   int;
begin
  if p_source not in ('DAILY', 'BUY', 'GIFT') then
    raise exception 'lom_open_pack: unknown source %', p_source;
  end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'array' or jsonb_array_length(p_plan) = 0 then
    raise exception 'lom_open_pack: empty plan';
  end if;

  -- One opening per manager at a time.
  perform 1 from profiles where id = p_profile for update;
  if not found then
    raise exception 'lom_open_pack: no profile %', p_profile;
  end if;

  select * into v_pack from pack_types where key = p_pack_type;
  if not found then
    raise exception 'lom:no_pack';
  end if;

  if p_source = 'DAILY' then
    if p_pack_day is null then
      raise exception 'lom_open_pack: a daily pack needs its pack day';
    end if;

    insert into pack_claims (profile_id, pack_day)
    values (p_profile, p_pack_day)
    on conflict (profile_id, pack_day) do nothing;

    select id, settled_at into v_claim_id, v_settled
      from pack_claims
     where profile_id = p_profile and pack_day = p_pack_day
       for update;

    if v_settled is not null then
      return jsonb_build_object('status', 'already');
    end if;

    -- The streak upgrade belongs to the first pack opened on a day, once.
    if p_bonus and exists (
      select 1 from pack_claims
       where profile_id = p_profile
         and opened_day = coalesce(p_opened_day, p_pack_day)
         and settled_at is not null
    ) then
      return jsonb_build_object('status', 'bonus_taken');
    end if;

  elsif p_source = 'GIFT' then
    select * into v_gift from pack_gifts
     where id = p_gift and profile_id = p_profile
       for update;

    if not found then
      return jsonb_build_object('status', 'missing');
    end if;
    if v_gift.opened_at is not null then
      return jsonb_build_object('status', 'already');
    end if;
    if v_gift.pack_type <> p_pack_type then
      raise exception 'lom_open_pack: gift % is a % pack', p_gift, v_gift.pack_type;
    end if;

  else
    if not v_pack.is_active or v_pack.key = 'DAILY' then
      raise exception 'lom:no_pack';
    end if;
    v_price := v_pack.price;

    -- Counted under the profile lock, so two taps cannot both see "one left".
    if v_pack.daily_limit is not null then
      select count(*) into v_used
        from pack_openings
       where profile_id = p_profile
         and pack_type = v_pack.key
         and pack_day = p_pack_day;
      if v_used >= v_pack.daily_limit then
        raise exception 'lom:limit';
      end if;
    end if;
  end if;

  insert into pack_openings (profile_id, pack_type, pack_day, credits_spent, claim_id, gift_id)
  values (
    p_profile,
    v_pack.key,
    case when p_source = 'GIFT' then null else p_pack_day end,
    v_price,
    v_claim_id,
    case when p_source = 'GIFT' then p_gift else null end
  )
  returning id into v_opening;

  if v_price > 0 then
    begin
      perform grant_credits(p_profile, -v_price, 'PACK:' || v_pack.key, v_opening);
    exception when others then
      raise exception 'lom:funds';
    end;
  end if;

  insert into pity_counters (profile_id) values (p_profile)
  on conflict (profile_id) do nothing;

  select since_legendary, since_icon, packs_opened
    into v_since_l, v_since_i, v_opened
    from pity_counters
   where profile_id = p_profile
     for update;

  for v_slot in
    select value from jsonb_array_elements(p_plan) order by (value ->> 'slot')::int
  loop
    v_card := (v_slot ->> 'card')::uuid;
    v_band := v_slot ->> 'band';
    v_gain := 0;
    v_credits := 0;

    select * into v_held from collection_cards
     where profile_id = p_profile and card_definition_id = v_card
       for update;

    if found then
      v_dup := true;
      v_level := v_held.level;
      v_xp := v_held.xp + greatest(0, coalesce((v_slot ->> 'dup_xp')::int, 0));
      while v_level < 10 and v_xp >= 400 loop
        v_xp := v_xp - 400;
        v_level := v_level + 1;
      end loop;
      if v_level >= 10 then
        v_xp := least(v_xp, 399);
      end if;
      -- What the card actually gained, which is less than the nominal amount at the cap.
      v_gain := (v_level * 400 + v_xp) - (v_held.level * 400 + v_held.xp);

      update collection_cards
         set level = v_level, xp = v_xp, copies = copies + 1
       where id = v_held.id;

      v_credits := greatest(0, coalesce((v_slot ->> 'dup_credits')::int, 0));
      if v_credits > 0 then
        perform grant_credits(p_profile, v_credits, 'DUPLICATE', v_opening);
        v_earned := v_earned + v_credits;
      end if;
    else
      v_dup := false;
      insert into collection_cards (profile_id, card_definition_id, source)
      values (p_profile, v_card, 'PACK');
    end if;

    insert into pack_opening_cards
      (opening_id, slot, card_definition_id, rarity, was_duplicate, xp_awarded, credits_awarded)
    values
      (v_opening, (v_slot ->> 'slot')::int, v_card, v_band, v_dup, v_gain, v_credits);

    v_opened := v_opened + 1;
    v_since_l := case when v_band in ('LEGENDARY', 'ICON') then 0 else v_since_l + 1 end;
    v_since_i := case when v_band = 'ICON' then 0 else v_since_i + 1 end;

    v_cards := v_cards || jsonb_build_array(jsonb_build_object(
      'slot', (v_slot ->> 'slot')::int,
      'card', v_card,
      'band', v_band,
      'was_duplicate', v_dup,
      'xp_awarded', v_gain,
      'credits_awarded', v_credits
    ));
  end loop;

  update pity_counters
     set since_legendary = v_since_l,
         since_icon = v_since_i,
         packs_opened = v_opened,
         updated_at = now()
   where profile_id = p_profile;

  if p_source = 'DAILY' then
    v_first := v_cards -> 0;
    update pack_claims
       set settled_at = now(),
           opening_id = v_opening,
           opened_day = coalesce(p_opened_day, p_pack_day),
           streak_bonus = coalesce(p_bonus, false),
           card_definition_id = (v_first ->> 'card')::uuid,
           rarity = v_first ->> 'band',
           was_duplicate = (v_first ->> 'was_duplicate')::boolean,
           xp_awarded = (v_first ->> 'xp_awarded')::int
     where id = v_claim_id;
  elsif p_source = 'GIFT' then
    update pack_gifts
       set opened_at = now(),
           seen_at = coalesce(seen_at, now()),
           opening_id = v_opening
     where id = p_gift;
  end if;

  select credits into v_balance from profiles where id = p_profile;

  return jsonb_build_object(
    'status', 'opened',
    'opening_id', v_opening,
    'spent', v_price,
    'credits_earned', v_earned,
    'credits', v_balance,
    'cards', v_cards
  );
end;
$$;

revoke all on function public.lom_open_pack(uuid, text, text, jsonb, date, date, uuid, boolean) from public, anon, authenticated;
grant execute on function public.lom_open_pack(uuid, text, text, jsonb, date, date, uuid, boolean) to service_role;

-- -----------------------------------------------------------------------------
-- 4. Quests
--
-- The quests themselves (what counts, what they pay, which three are live on a
-- given day or week) are code in server/utils/quests.ts; progress is computed
-- from duels and openings that already exist. What has to be durable is the
-- payout, and the unique key is what makes it pay once per period.
--
-- period_key is the pack day ('2026-11-21') for a daily quest and 'W' plus the
-- Monday pack day ('W2026-11-16') for a weekly one.
-- -----------------------------------------------------------------------------

create table if not exists quest_claims (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles(id) on delete cascade,
  quest_key   text not null,
  period_key  text not null,
  credits     int not null check (credits > 0),
  claimed_at  timestamptz not null default now(),
  unique (profile_id, quest_key, period_key)
);

comment on table quest_claims is
  'One row per quest paid. The unique key is the lock: a quest claimed twice pays once.';

create index if not exists quest_claims_profile_idx
  on quest_claims (profile_id, claimed_at desc);

create or replace function public.lom_claim_quest(
  p_profile uuid,
  p_quest   text,
  p_period  text,
  p_credits int
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id      uuid;
  v_balance int;
begin
  if p_credits is null or p_credits <= 0 then
    raise exception 'lom_claim_quest: nothing to pay';
  end if;

  insert into quest_claims (profile_id, quest_key, period_key, credits)
  values (p_profile, p_quest, p_period, p_credits)
  on conflict (profile_id, quest_key, period_key) do nothing
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('status', 'already');
  end if;

  v_balance := grant_credits(p_profile, p_credits, 'QUEST:' || p_quest, v_id);
  return jsonb_build_object('status', 'claimed', 'credits', v_balance, 'id', v_id);
end;
$$;

revoke all on function public.lom_claim_quest(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.lom_claim_quest(uuid, text, text, int) to service_role;

alter table quest_claims enable row level security;

drop policy if exists quest_claims_select_own on quest_claims;
create policy quest_claims_select_own on quest_claims
  for select to authenticated using (profile_id = auth.uid());

revoke insert, update, delete, truncate on table quest_claims from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. The Scouting pack
--
-- Pity counts cards, and a Scouting pack is three of them. At 150 Credits that
-- made a pity Legendary cost about 2000 (40 cards), under the 2500 of a Legacy
-- pack that exists to sell exactly that. 200 puts the pity route at ~2670, so
-- the Legacy pack is the cheaper way to a Legendary again, and Scouting stays
-- the cheapest way to squad depth. The blurb also stops promising "nobody
-- famous", which a pity guarantee can contradict.
-- -----------------------------------------------------------------------------

update pack_types
   set price = 200,
       blurb = 'Three players, Epic at most: squad depth, not a lottery ticket. A Legendary or Icon guarantee you have already earned still pays out here.'
 where key = 'SCOUTING';
