-- immutability of snapshots
create or replace function cx.guard_snapshot() returns trigger language plpgsql set search_path = '' as $$
begin
  if current_setting('cx.allow_snapshot_edit', true) = 'on' then return coalesce(new, old); end if;
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  raise exception 'Order snapshots are immutable. Use staff_correct_order_snapshot (audited).';
end $$;
create trigger guard_order_snapshots before update or delete on public.order_snapshots for each row execute function cx.guard_snapshot();
create trigger guard_order_snapshot_lines before update or delete on public.order_snapshot_lines for each row execute function cx.guard_snapshot();
create trigger guard_order_snapshot_components before update or delete on public.order_snapshot_components for each row execute function cx.guard_snapshot();

-- order changes -> snapshot + targeted refresh. Never allowed to break ordering/billing: all errors are caught and logged.
create or replace function cx.trg_orders() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_old uuid;
begin
  begin
    if tg_op = 'DELETE' then
      select id into v_id from public.customer_identities where phone_raw = old.phone;
      if old.status = 'delivered' and v_id is not null then perform cx.refresh_customer(v_id); end if;
      return old;
    end if;
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
create trigger cx_orders_ins after insert on public.orders for each row execute function cx.trg_orders();
create trigger cx_orders_upd after update of status, items, total, delivered_at, date, phone on public.orders for each row execute function cx.trg_orders();
create trigger cx_orders_del after delete on public.orders for each row execute function cx.trg_orders();

-- published menu history, captured whenever the owner saves the daily plan
alter table public.menu_publications drop constraint if exists menu_publications_service_date_content_hash_key;
create index if not exists menu_pub_date_idx on public.menu_publications(service_date, published_at desc);

create or replace function cx.trg_plan_config() returns trigger language plpgsql security definer set search_path = '' as $$
declare v jsonb; d date; v_hash text; v_last text; pid bigint; e jsonb; nm text; names jsonb;
begin
  begin
    if new.key <> 'ht_plan_config' then return new; end if;
    v := new.value;
    if coalesce(v->>'date','') !~ '^\d{4}-\d{2}-\d{2}$' then return new; end if;
    d := (v->>'date')::date;
    select jsonb_agg(jsonb_build_object('n', lower(trim(x->>'name')), 'p', coalesce((x->>'premium')::boolean, false)) order by lower(trim(x->>'name')))
      into names from jsonb_array_elements(coalesce(v->'sabjis','[]'::jsonb)) x where coalesce(trim(x->>'name'),'') <> '';
    if names is null then return new; end if;
    v_hash := md5(jsonb_build_array(names, lower(trim(coalesce(v->>'rice',''))), lower(trim(coalesce(v->>'raita',''))),
                  lower(trim(coalesce(v->>'sweet',''))), lower(trim(coalesce(v->>'salad',''))))::text);
    select content_hash into v_last from public.menu_publications where service_date = d order by published_at desc, id desc limit 1;
    if v_last is not distinct from v_hash then return new; end if;
    insert into public.menu_publications(service_date, content_hash, raw)
    values (d, v_hash, jsonb_build_object('sabjis', coalesce(v->'sabjis','[]'::jsonb) , 'rice', v->'rice', 'raita', v->'raita',
            'sweet', v->'sweet', 'salad', v->'salad', 'prices', v->'prices', 'enabled', v->'enabled'))
    returning id into pid;
    for e in select * from jsonb_array_elements(coalesce(v->'sabjis','[]'::jsonb)) loop
      nm := trim(coalesce(e->>'name',''));
      if nm <> '' then
        insert into public.menu_publication_dishes(publication_id, dish_id, role, premium)
        values (pid, cx.resolve_dish(nm, cx._main_cat(nm)), 'sabji', coalesce((e->>'premium')::boolean, false)) on conflict do nothing;
      end if;
    end loop;
    if coalesce(trim(v->>'rice'),'') <> '' then insert into public.menu_publication_dishes values (pid, cx.resolve_dish(v->>'rice','rice'), 'rice', false) on conflict do nothing; end if;
    if coalesce(trim(v->>'raita'),'') <> '' then insert into public.menu_publication_dishes values (pid, cx.resolve_dish(v->>'raita','raita'), 'raita', false) on conflict do nothing; end if;
    if coalesce(trim(v->>'sweet'),'') <> '' then insert into public.menu_publication_dishes values (pid, cx.resolve_dish(v->>'sweet','sweet'), 'sweet', false) on conflict do nothing; end if;
    if coalesce(trim(v->>'salad'),'') <> '' then insert into public.menu_publication_dishes values (pid, cx.resolve_dish(v->>'salad','salad'), 'salad', false) on conflict do nothing; end if;
  exception when others then
    perform cx.log_error(null, null, 'plan_config_trigger', sqlerrm);
  end;
  return new;
end $$;
create trigger cx_plan_config after insert or update on public.app_data for each row execute function cx.trg_plan_config();

revoke all on all functions in schema cx from public, anon, authenticated;

-- one-time capture of the menu currently published (touch the row so the trigger records it)
update public.app_data set value = value where key = 'ht_plan_config';
update public.menu_publications set source = 'backfill_current_config' where source = 'trigger';

-- daily refresh so inactivity buckets and 30/90-day windows stay current without new orders (00:05 IST = 18:35 UTC)
create extension if not exists pg_cron with schema pg_catalog;
do $$ begin
  perform cron.unschedule('cx-refresh-all-daily');
exception when others then null;
end $$;
select cron.schedule('cx-refresh-all-daily', '35 18 * * *', $cron$select cx.refresh_all('cron_daily')$cron$);