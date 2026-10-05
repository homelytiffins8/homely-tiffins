create or replace function cx.refresh_customer(p_customer uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_root uuid; v_phones text[]; v_as_of date := cx.today_ist();
  v_cnt int; v_first date; v_last date; v_net numeric; v_gross numeric; v_disc numeric; v_est int;
  v_vc jsonb; v_sz jsonb; v_slot jsonb; v_dow jsonb; v_usual text; v_usual_sz text; v_med numeric; v_opw numeric;
  v_win jsonb := '{}'::jsonb; v_shift text; v_cov jsonb; v_t30 int; v_tp30 int;
  v_d30 text; v_p30 text; v_name text; v_tower text; v_flat text; v_nodate int; rec record;
begin
  if p_customer is null then return jsonb_build_object('ok', false, 'error', 'no customer'); end if;
  v_root := cx.root_of(p_customer);
  if v_root <> p_customer then
    delete from public.customer_dish_stats where customer_id = p_customer;
    delete from public.customer_analysis where customer_id = p_customer;
  end if;
  with recursive t as (
    select id, phone_raw from public.customer_identities where id = v_root
    union all
    select c.id, c.phone_raw from public.customer_identities c join t on c.merged_into = t.id)
  select array_agg(phone_raw) into v_phones from t;

  for rec in select ord.id from public.orders ord where ord.phone = any(v_phones)
           and not exists (select 1 from public.order_snapshots s where s.order_id = ord.id) loop
    begin perform cx.build_snapshot(rec.id, 'backfill_from_order_items');
    exception when others then perform cx.log_error(v_root, rec.id, 'build_snapshot', sqlerrm); end;
  end loop;

  select count(*), min(ddate), max(ddate), coalesce(sum(total),0), coalesce(sum(gross),0), coalesce(sum(discount),0),
         count(*) filter (where date_est)
    into v_cnt, v_first, v_last, v_net, v_gross, v_disc, v_est
  from cx.delivered_set(v_phones);

  select count(*) into v_nodate from public.orders ord where ord.phone = any(v_phones) and ord.status = 'delivered'
    and ord.delivered_at is null and ord.date !~ '^\d{4}-\d{2}-\d{2}$';

  select coalesce(jsonb_object_agg(variant, c), '{}') into v_vc from (select variant, count(*) c from cx.delivered_set(v_phones) group by 1) s;
  select coalesce(jsonb_object_agg(size, c), '{}') into v_sz from (select size, count(*) c from cx.delivered_set(v_phones) where size is not null and variant like 'gold%' group by 1) s;
  select coalesce(jsonb_object_agg(slot, c), '{}') into v_slot from (select slot, count(*) c from cx.delivered_set(v_phones) group by 1) s;
  select coalesce(jsonb_object_agg(dow, c), '{}') into v_dow from (select dow, count(*) c from cx.delivered_set(v_phones) group by 1) s;

  select variant into v_usual from (select variant, count(*) c, max(ddate) l from cx.delivered_set(v_phones) where variant not in ('unknown') group by 1) s order by c desc, l desc, variant limit 1;
  select size into v_usual_sz from (select size, count(*) c, max(ddate) l from cx.delivered_set(v_phones) where size is not null and variant like 'gold%' group by 1) s order by c desc, l desc limit 1;

  select percentile_cont(0.5) within group (order by gap) into v_med from (
    select ddate - lag(ddate) over (order by ddate) as gap from (select distinct ddate from cx.delivered_set(v_phones)) d) g where gap is not null;
  v_opw := case when v_cnt > 0 then round(v_cnt / greatest(1, ceil(((v_last - v_first) + 1) / 7.0)), 2) end;

  select jsonb_object_agg(w.win, jsonb_build_object('from', w.lo, 'to', w.hi, 'orders', coalesce(x.n,0), 'spend', coalesce(x.s,0), 'variants', coalesce(x.v,'{}'::jsonb)))
  into v_win
  from (values ('d30', v_as_of - 29, v_as_of), ('prev30', v_as_of - 59, v_as_of - 30), ('d90', v_as_of - 89, v_as_of)) as w(win, lo, hi)
  left join lateral (
    select count(*)::int n, sum(total) s,
      (select coalesce(jsonb_object_agg(variant, c), '{}') from (select q.variant, count(*) c from cx.delivered_set(v_phones) q where q.ddate between w.lo and w.hi group by 1) z) v
    from cx.delivered_set(v_phones) d where d.ddate between w.lo and w.hi) x on true;

  select v.variant into v_d30 from (select d.variant, count(*) c, vm.tier from cx.delivered_set(v_phones) d join public.variant_map vm on vm.variant = d.variant and vm.is_meal
     where d.ddate between v_as_of - 29 and v_as_of group by d.variant, vm.tier) v order by c desc, tier desc limit 1;
  select v.variant into v_p30 from (select d.variant, count(*) c, vm.tier from cx.delivered_set(v_phones) d join public.variant_map vm on vm.variant = d.variant and vm.is_meal
     where d.ddate between v_as_of - 59 and v_as_of - 30 group by d.variant, vm.tier) v order by c desc, tier desc limit 1;
  v_shift := case when v_d30 is null or v_p30 is null then 'insufficient_data'
    when (select tier from public.variant_map where variant = v_d30) > (select tier from public.variant_map where variant = v_p30) then 'up'
    when (select tier from public.variant_map where variant = v_d30) < (select tier from public.variant_map where variant = v_p30) then 'down'
    else 'same' end;

  select jsonb_build_object(
    'delivered_orders', v_cnt,
    'snapshot_full', count(*) filter (where s.coverage = 'full'),
    'snapshot_partial', count(*) filter (where s.coverage = 'partial'),
    'snapshot_none', count(*) filter (where s.coverage = 'none' or s.coverage is null),
    'estimated_date_orders', v_est,
    'orders_without_any_date', v_nodate,
    'orders_with_menu_record', count(*) filter (where s.menu_publication_id is not null))
  into v_cov
  from cx.delivered_set(v_phones) d left join public.order_snapshots s on s.order_id = d.order_id;

  select o2.customer_name, o2.tower, o2.flat into v_name, v_tower, v_flat
  from public.orders o2 where o2.phone = any(v_phones) order by o2.created_at desc limit 1;
  update public.customer_identities set
    display_name = coalesce(v_name, display_name), tower = coalesce(v_tower, tower), flat = coalesce(v_flat, flat)
  where id = v_root;

  insert into public.customer_analysis as a(customer_id, as_of_date, refreshed_at, first_delivered_date, last_delivered_date,
    delivered_orders, gross_amount, discount_amount, net_spend, avg_order_value, usual_variant, variant_counts, usual_size, size_counts,
    slot_counts, weekday_counts, median_gap_days, orders_per_week, windows, variant_shift, coverage)
  values (v_root, v_as_of, now(), v_first, v_last, v_cnt, v_gross, v_disc, v_net,
    case when v_cnt > 0 then round(v_net / v_cnt, 2) end, v_usual, v_vc, v_usual_sz, v_sz, v_slot, v_dow, v_med, v_opw, v_win, v_shift, v_cov)
  on conflict (customer_id) do update set
    as_of_date = excluded.as_of_date, refreshed_at = excluded.refreshed_at, first_delivered_date = excluded.first_delivered_date,
    last_delivered_date = excluded.last_delivered_date, delivered_orders = excluded.delivered_orders, gross_amount = excluded.gross_amount,
    discount_amount = excluded.discount_amount, net_spend = excluded.net_spend, avg_order_value = excluded.avg_order_value,
    usual_variant = excluded.usual_variant, variant_counts = excluded.variant_counts, usual_size = excluded.usual_size,
    size_counts = excluded.size_counts, slot_counts = excluded.slot_counts, weekday_counts = excluded.weekday_counts,
    median_gap_days = excluded.median_gap_days, orders_per_week = excluded.orders_per_week, windows = excluded.windows,
    variant_shift = excluded.variant_shift, coverage = excluded.coverage;

  delete from public.customer_dish_stats where customer_id = v_root;
  insert into public.customer_dish_stats(customer_id, dish_id, win, role_group, category, delivered_orders, explicit_orders, fixed_orders,
      qty, first_date, last_date, last_explicit_date)
  select v_root, x.dish_id, x.win,
    case min(x.role) when 'main' then 'main' when 'bread' then 'bread' else 'side' end, min(x.category),
    count(distinct x.order_id), count(distinct x.order_id) filter (where x.selection = 'chosen'),
    count(distinct x.order_id) filter (where x.selection = 'fixed'),
    sum(x.unit_qty * x.line_qty), min(x.ddate), max(x.ddate), max(x.ddate) filter (where x.selection = 'chosen')
  from (
    select w.win, c.dish_id, c.role, c.category, c.selection, c.unit_qty, l.qty as line_qty, d.order_id, d.ddate
    from (values ('lifetime', date '1900-01-01', date '9999-12-31'), ('d30', v_as_of - 29, v_as_of),
                 ('d90', v_as_of - 89, v_as_of), ('prev30', v_as_of - 59, v_as_of - 30)) as w(win, lo, hi)
    cross join cx.delivered_set(v_phones) d
    join public.order_snapshot_components c on c.order_id = d.order_id and c.dish_id is not null
    join public.order_snapshot_lines l on l.order_id = c.order_id and l.line_index = c.line_index
    where d.ddate between w.lo and w.hi
  ) x group by x.win, x.dish_id;

  update public.customer_dish_stats s set eligible_orders = e.elig, selected_of_eligible = e.sel
  from (
    select w.win, mpd.dish_id, count(distinct d.order_id)::int as elig,
      (count(distinct d.order_id) filter (where exists (
        select 1 from public.order_snapshot_components c2
        where c2.order_id = d.order_id and c2.dish_id = mpd.dish_id and c2.selection = 'chosen')))::int as sel
    from (values ('lifetime', date '1900-01-01', date '9999-12-31'), ('d30', v_as_of - 29, v_as_of),
                 ('d90', v_as_of - 89, v_as_of), ('prev30', v_as_of - 59, v_as_of - 30)) as w(win, lo, hi)
    cross join cx.delivered_set(v_phones) d
    join public.order_snapshots sn on sn.order_id = d.order_id and sn.menu_publication_id is not null
    join public.menu_publication_dishes mpd on mpd.publication_id = sn.menu_publication_id and mpd.role = 'sabji'
    where d.ddate between w.lo and w.hi
      and exists (select 1 from public.order_snapshot_lines l where l.order_id = d.order_id
                  and (l.variant in ('goldMedium','goldLarge','goldMini') or (l.variant = 'mini' and not mpd.premium)))
    group by w.win, mpd.dish_id
  ) e where s.customer_id = v_root and s.win = e.win and s.dish_id = e.dish_id;

  update public.analysis_errors set resolved_at = now() where customer_id = v_root and resolved_at is null;
  return jsonb_build_object('ok', true, 'customer_id', v_root, 'delivered_orders', v_cnt, 'as_of', v_as_of);
exception when others then
  perform cx.log_error(p_customer, null, 'refresh_customer', sqlerrm);
  return jsonb_build_object('ok', false, 'customer_id', p_customer, 'error', sqlerrm);
end $$;
revoke all on all functions in schema cx from public, anon, authenticated;
delete from public.analysis_errors; delete from public.analysis_runs;