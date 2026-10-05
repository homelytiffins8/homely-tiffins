-- Owner action: delete inactive customers (7-13 days / 14+ days since last delivery).
-- Removes the customer's profile (customers row, identity, notes, contact log, prefs, feedback, form tokens, analysis).
-- Orders and credit_ledger rows are intentionally KEPT (sales history / accounting).
-- A tombstone stops the nightly refresh_all and old-order updates from re-creating the identity;
-- a brand-new order from the same phone clears the tombstone and the customer reappears normally.

create table if not exists public.customer_deletions (
  phone_raw text primary key,
  deleted_at timestamptz not null default now(),
  deleted_by text
);
alter table public.customer_deletions enable row level security;
-- no policies: only SECURITY DEFINER functions touch it

create or replace function cx.ensure_identity(p_phone text, p_name text default null, p_tower text default null, p_flat text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  if coalesce(trim(p_phone),'') = '' then return null; end if;
  select id into v from public.customer_identities where phone_raw = p_phone;
  if v is null then
    if exists (select 1 from public.customer_deletions where phone_raw = p_phone) then return null; end if;
    insert into public.customer_identities(phone_raw, phone_norm, display_name, tower, flat, society)
    values (p_phone, cx.norm_phone(p_phone), p_name, p_tower, p_flat,
            (select value #>> '{}' from public.cx_config where key = 'default_society'))
    on conflict (phone_raw) do nothing;
    select id into v from public.customer_identities where phone_raw = p_phone;
  end if;
  return v;
end $$;

create or replace function cx.trg_orders()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_old uuid;
begin
  begin
    if tg_op = 'DELETE' then
      select id into v_id from public.customer_identities where phone_raw = old.phone;
      if old.status = 'delivered' and v_id is not null then perform cx.refresh_customer(v_id); end if;
      return old;
    end if;
    if tg_op = 'INSERT' then delete from public.customer_deletions where phone_raw = new.phone; end if;
    v_id := cx.ensure_identity(new.phone, new.customer_name, new.tower, new.flat);
    if tg_op = 'INSERT' then
      perform cx.build_snapshot(new.id, 'captured_at_order');
    else
      if not exists (select 1 from public.order_snapshots where order_id = new.id) then
        perform cx.build_snapshot(new.id, 'backfill_from_order_items');
      elsif new.items is distinct from old.items then
        perform set_config('cx.allow_snapshot_edit', 'on', true);
        update public.order_snapshots set needs_review = true,
          review_reason = 'Order items changed after the snapshot was taken (' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') || ' IST)'
        where order_id = new.id;
        perform set_config('cx.allow_snapshot_edit', 'off', true);
      end if;
    end if;
    if v_id is not null and ((tg_op = 'INSERT' and new.status = 'delivered')
        or (tg_op = 'UPDATE' and (old.status = 'delivered' or new.status = 'delivered'))) then
      perform cx.refresh_customer(v_id);
      if tg_op = 'UPDATE' and old.phone is distinct from new.phone then
        select id into v_old from public.customer_identities where phone_raw = old.phone;
        if v_old is not null then perform cx.refresh_customer(v_old); end if;
      end if;
    end if;
  exception when others then
    perform set_config('cx.allow_snapshot_edit', 'off', true);
    perform cx.log_error(v_id, coalesce(new.id, old.id), 'orders_trigger', sqlerrm);
  end;
  return coalesce(new, old);
end $$;

-- p_bucket: 'inactive_7_13' | 'inactive_14_plus'. The bucket is re-checked server-side
-- (same rule as cx.customer_summary), so a stale list can never delete an active customer.
create table if not exists public.customer_archive (
  id bigserial primary key,
  deleted_at timestamptz not null default now(),
  deleted_by text,
  bucket text,
  phones text[],
  name text,
  snapshot jsonb not null
);
alter table public.customer_archive enable row level security;
-- no policies: readable only via SQL / service role (restore data from here if a deletion was a mistake)
create or replace function public.staff_delete_inactive_customers(p_bucket text, p_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_today date := cx.today_ist(); v_by text := cx.staff_email();
  r record; v_ids uuid[]; v_phones text[]; v_del int := 0;
begin
  perform cx.require_staff();
  if p_bucket not in ('inactive_7_13', 'inactive_14_plus') then raise exception 'invalid bucket'; end if;
  for r in
    select i.id from public.customer_identities i
    join public.customer_analysis a on a.customer_id = i.id
    where i.id = any(coalesce(p_ids, '{}')) and i.merged_into is null and a.last_delivered_date is not null
      and case when p_bucket = 'inactive_7_13' then greatest(0, v_today - a.last_delivered_date) between 7 and 13
               else greatest(0, v_today - a.last_delivered_date) >= 14 end
  loop
    v_ids := cx.group_ids(r.id); v_phones := cx.group_phones(r.id);
    if exists (select 1 from public.orders where phone = any(v_phones) and status not in ('delivered', 'rejected', 'cancelled')) then
      continue;   -- never delete someone with an order still in progress
    end if;
    insert into public.customer_archive(deleted_by, bucket, phones, name, snapshot)
    select v_by, p_bucket, v_phones, (select display_name from public.customer_identities where id = r.id), jsonb_build_object(
      'identities', coalesce((select jsonb_agg(to_jsonb(x)) from public.customer_identities x where x.id = any(v_ids)), '[]'),
      'customers', coalesce((select jsonb_agg(to_jsonb(x)) from public.customers x where x.phone = any(v_phones)), '[]'),
      'analysis', coalesce((select jsonb_agg(to_jsonb(x)) from public.customer_analysis x where x.customer_id = any(v_ids)), '[]'),
      'prefs', coalesce((select jsonb_agg(to_jsonb(x)) from public.customer_pref_log x where x.customer_id = any(v_ids)), '[]'),
      'notes', coalesce((select jsonb_agg(to_jsonb(x)) from public.customer_internal_notes x where x.customer_id = any(v_ids)), '[]'),
      'contact_log', coalesce((select jsonb_agg(to_jsonb(x)) from public.contact_log x where x.customer_id = any(v_ids)), '[]'),
      'feedback', coalesce((select jsonb_agg(to_jsonb(x)) from public.customer_feedback x where x.customer_id = any(v_ids)), '[]'),
      'form_submissions', coalesce((select jsonb_agg(to_jsonb(x)) from public.preference_form_submissions x where x.customer_id = any(v_ids)), '[]'),
      'dish_stats', coalesce((select jsonb_agg(to_jsonb(x)) from public.customer_dish_stats x where x.customer_id = any(v_ids)), '[]'));
    delete from public.customer_dish_stats where customer_id = any(v_ids);
    delete from public.customer_pref_log where customer_id = any(v_ids);
    delete from public.customer_internal_notes where customer_id = any(v_ids);
    delete from public.contact_log where customer_id = any(v_ids);
    delete from public.customer_feedback where customer_id = any(v_ids);
    delete from public.preference_form_submissions where customer_id = any(v_ids);
    delete from public.preference_form_tokens where customer_id = any(v_ids);
    delete from public.customer_analysis where customer_id = any(v_ids);
    delete from public.duplicate_dismissals where a = any(v_ids) or b = any(v_ids);
    delete from public.customer_identities where id = any(v_ids);
    delete from public.customers where phone = any(v_phones);
    insert into public.customer_deletions(phone_raw, deleted_by) select unnest(v_phones), v_by on conflict (phone_raw) do update set deleted_at = now(), deleted_by = excluded.deleted_by;
    v_del := v_del + 1;
  end loop;
  -- skipped = open order in progress, or no longer in that bucket / not found
  return jsonb_build_object('deleted', v_del, 'skipped', coalesce(array_length(p_ids, 1), 0) - v_del);
end $$;
revoke all on function public.staff_delete_inactive_customers(text, uuid[]) from public, anon;
grant execute on function public.staff_delete_inactive_customers(text, uuid[]) to authenticated;
