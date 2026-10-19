-- Customer accounts — step 2: customer identity + My Homely profile.
--
-- A customer signs in with Supabase Auth phone + password (first time /
-- forgot password: SMS OTP). The ONLY thing trusted is the verified phone on
-- their auth.users row — never a phone or customer id sent by the browser.
-- That phone links them to the existing customers / customer_identities rows
-- (all phones are already stored as clean 10-digit numbers), so every
-- existing customer sees their history on first login with no backfill.
--
-- Customers never get table access; everything goes through the my_* RPCs.

create table if not exists public.customer_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  phone text not null unique check (phone ~ '^\d{10}$'),
  -- name/tower/flat here are only used until the customer's first order
  -- creates their row in public.customers (which is the primary profile).
  name text check (char_length(name) <= 80),
  tower text check (char_length(tower) <= 20),
  flat text check (char_length(flat) <= 20),
  delivery_instructions text check (char_length(delivery_instructions) <= 300),
  regular_order_id text references public.orders(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);
create index if not exists customer_accounts_regular_order_idx on public.customer_accounts(regular_order_id);

alter table public.customer_accounts enable row level security;
drop policy if exists customer_accounts_staff_read on public.customer_accounts;
create policy customer_accounts_staff_read on public.customer_accounts
  for select to authenticated using ((select public.is_staff()));

-- Verified phone of the signed-in customer (10 digits), or null.
create or replace function cx.my_phone()
returns text
language sql
stable
security definer
set search_path to ''
as $$
  select cx.norm_phone(u.phone)
  from auth.users u
  where u.id = auth.uid()
    and u.phone_confirmed_at is not null
    and coalesce(u.raw_app_meta_data ->> 'role', '') <> 'staff'
$$;

-- Every phone that belongs to this customer: their own, plus any phone the
-- owner has explicitly merged with it (customer_identities.merged_into).
-- Nothing is merged automatically here.
create or replace function cx.my_phones()
returns text[]
language plpgsql
stable
security definer
set search_path to ''
as $$
declare v_phone text := cx.my_phone(); v_id uuid; v_phones text[];
begin
  if v_phone is null then return null; end if;
  select id into v_id from public.customer_identities where phone_raw = v_phone;
  if v_id is not null then v_phones := cx.group_phones(cx.root_of(v_id)); end if;
  if v_phones is null or not (v_phone = any(v_phones)) then
    v_phones := coalesce(v_phones, '{}') || v_phone;
  end if;
  return v_phones;
end $$;

create or replace function cx.require_customer()
returns text
language plpgsql
stable
security definer
set search_path to ''
as $$
declare v text := cx.my_phone();
begin
  if v is null then raise exception 'NOT_SIGNED_IN' using errcode = '42501'; end if;
  return v;
end $$;

-- Profile (creates the account row on first call, stamps last login).
create or replace function public.my_profile()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_phone text := cx.require_customer();
  v_phones text[] := cx.my_phones();
  v_acc public.customer_accounts;
  v_c public.customers;
  v_last public.orders;
  v_ident public.customer_identities;
  v_delivered int;
  v_total int;
begin
  insert into public.customer_accounts (user_id, phone, last_login_at)
  values (auth.uid(), v_phone, now())
  on conflict (user_id) do update set last_login_at = now();
  select * into v_acc from public.customer_accounts where user_id = auth.uid();

  select * into v_c from public.customers where phone = v_phone;
  select * into v_last from public.orders where phone = any(v_phones) order by created_at desc limit 1;
  select * into v_ident from public.customer_identities where phone_raw = v_phone;
  select count(*) filter (where status = 'delivered'), count(*)
    into v_delivered, v_total
  from public.orders where phone = any(v_phones);

  return jsonb_build_object(
    'phone', v_phone,
    'name', coalesce(nullif(v_c.name, ''), nullif(v_acc.name, ''), nullif(v_last.customer_name, ''), v_ident.display_name),
    'tower', coalesce(nullif(v_c.tower, ''), nullif(v_acc.tower, ''), nullif(v_last.tower, ''), v_ident.tower),
    'flat', coalesce(nullif(v_c.flat, ''), nullif(v_acc.flat, ''), nullif(v_last.flat, ''), v_ident.flat),
    'society', v_ident.society,
    'deliveryInstructions', v_acc.delivery_instructions,
    'regularOrderId', v_acc.regular_order_id,
    'referralCode', 'HT' || right(v_phone, 8),
    'totalOrders', v_total,
    'deliveredOrders', v_delivered,
    'memberSince', coalesce(v_c.first_order_date, to_char(v_acc.created_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD'))
  );
end $$;

create or replace function public.update_my_profile(p_name text, p_tower text, p_flat text, p_delivery_instructions text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_phone text := cx.require_customer();
  v_name text := trim(coalesce(p_name, ''));
  v_tower text := trim(coalesce(p_tower, ''));
  v_flat text := trim(coalesce(p_flat, ''));
  v_instr text := nullif(trim(coalesce(p_delivery_instructions, '')), '');
begin
  if v_name = '' or length(v_name) > 80 then raise exception 'INVALID_PROFILE: name is required'; end if;
  if v_tower = '' or length(v_tower) > 20 then raise exception 'INVALID_PROFILE: tower is required'; end if;
  if v_flat = '' or length(v_flat) > 20 then raise exception 'INVALID_PROFILE: flat is required'; end if;
  if length(v_instr) > 300 then raise exception 'INVALID_PROFILE: delivery instructions are too long'; end if;

  insert into public.customer_accounts (user_id, phone) values (auth.uid(), v_phone)
  on conflict (user_id) do nothing;

  -- The customers row is the primary profile (same fields checkout writes).
  -- Past orders keep the name/address they were placed with.
  update public.customers
     set name = v_name, tower = v_tower, flat = v_flat, updated_at = now()
   where phone = v_phone;
  if found then
    update public.customer_accounts
       set name = null, tower = null, flat = null, delivery_instructions = v_instr, updated_at = now()
     where user_id = auth.uid();
  else
    update public.customer_accounts
       set name = v_name, tower = v_tower, flat = v_flat, delivery_instructions = v_instr, updated_at = now()
     where user_id = auth.uid();
  end if;

  -- Keep the owner's Customers tab in step.
  update public.customer_identities
     set display_name = v_name, tower = v_tower, flat = v_flat
   where phone_raw = v_phone;

  return public.my_profile();
end $$;

revoke all on function public.my_profile() from public, anon;
revoke all on function public.update_my_profile(text, text, text, text) from public, anon;
grant execute on function public.my_profile() to authenticated;
grant execute on function public.update_my_profile(text, text, text, text) to authenticated;
revoke all on function cx.my_phone() from public, anon, authenticated;
revoke all on function cx.my_phones() from public, anon, authenticated;
revoke all on function cx.require_customer() from public, anon, authenticated;
