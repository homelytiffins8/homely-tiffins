-- Customer accounts — step 1: separate staff from customers.
--
-- Until now every signed-in user was the owner, so is_staff() and the
-- owner_full_access_* policies only checked "is authenticated". Customer
-- logins (phone + password) would have inherited full access to every
-- order, customer and ledger row. Staff is now an explicit role stored in
-- auth.users.raw_app_meta_data (only settable server-side, never by the user).
--
-- After applying: the owner must sign out and back in once so the new
-- claim is present in their session token.

-- 1. is_staff(): explicit role claim instead of "any signed-in user".
create or replace function public.is_staff()
returns boolean
language sql
stable
set search_path to ''
as $$
  select coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', '') = 'staff'
$$;

-- 2. Mark the existing owner account(s) as staff. Every account that exists
--    before customer logins launch is an owner account.
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"staff"}'::jsonb
where email is not null
  and coalesce(raw_app_meta_data ->> 'role', '') <> 'staff'
  and created_at < now();

-- 3. Owner-only tables: "authenticated" → staff.
do $$
declare t text;
begin
  foreach t in array array['orders','customers','credit_ledger','contact_messages','poll_responses'] loop
    execute format('drop policy if exists owner_full_access_%1$s on public.%1$I', t);
    execute format(
      'create policy owner_full_access_%1$s on public.%1$I for all to authenticated
         using ((select public.is_staff())) with check ((select public.is_staff()))', t);
  end loop;
end $$;

drop policy if exists owner_reads_site_events on public.site_events;
create policy owner_reads_site_events on public.site_events
  for select to authenticated using ((select public.is_staff()));

-- 4. app_data holds prices, menu, promo codes and settings. Reads stay public
--    (the menu page needs them); writes were open to anyone with the public
--    key, which let anyone rewrite prices that place_order trusts.
drop policy if exists "Anyone can insert" on public.app_data;
drop policy if exists "Anyone can update" on public.app_data;
drop policy if exists "Anyone can delete" on public.app_data;
create policy app_data_staff_insert on public.app_data
  for insert to authenticated with check ((select public.is_staff()));
create policy app_data_staff_update on public.app_data
  for update to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));
create policy app_data_staff_delete on public.app_data
  for delete to authenticated using ((select public.is_staff()));

-- 5. Guest order tracking by phone: limit to recent orders. Full history is
--    only available to the signed-in customer (my_orders, next migration).
create or replace function public.get_orders_by_phone(p_phone text)
returns setof public.orders
language sql
security definer
set search_path to 'public'
as $$
  select *
  from public.orders
  where phone = p_phone
    and created_at >= now() - interval '7 days'
  order by created_at desc
  limit 30;
$$;
