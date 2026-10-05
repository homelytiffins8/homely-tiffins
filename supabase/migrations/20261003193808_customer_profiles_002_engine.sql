insert into public.variant_map(variant,label,tier,is_meal,notes) values ('unknown','Unknown',0,false,'Order lines that could not be classified') on conflict do nothing;

create or replace function cx.norm_phone(p text) returns text language sql immutable set search_path = '' as $$
  select case when length(d) >= 10 then right(d,10) when d = '' then null else d end
  from (select regexp_replace(coalesce(p,''), '\D', '', 'g') as d) s $$;

create or replace function cx.today_ist() returns date language sql stable set search_path = '' as $$
  select (now() at time zone 'Asia/Kolkata')::date $$;

create or replace function cx.dish_key(p text) returns text language sql immutable set search_path = '' as $$
  select regexp_replace(lower(coalesce(p,'')), '[^a-z0-9]+', '', 'g') $$;

create or replace function cx.root_of(p uuid) returns uuid language plpgsql stable set search_path = '' as $$
declare r uuid := p; n uuid; i int := 0;
begin
  loop
    select merged_into into n from public.customer_identities where id = r;
    exit when n is null or i > 20;
    r := n; i := i + 1;
  end loop;
  return r;
end $$;

create or replace function cx.ensure_identity(p_phone text, p_name text default null, p_tower text default null, p_flat text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  if coalesce(trim(p_phone),'') = '' then return null; end if;
  select id into v from public.customer_identities where phone_raw = p_phone;
  if v is null then
    insert into public.customer_identities(phone_raw, phone_norm, display_name, tower, flat, society)
    values (p_phone, cx.norm_phone(p_phone), p_name, p_tower, p_flat,
            (select value #>> '{}' from public.cx_config where key = 'default_society'))
    on conflict (phone_raw) do nothing;
    select id into v from public.customer_identities where phone_raw = p_phone;
  end if;
  return v;
end $$;

create or replace function cx.resolve_dish(p_label text, p_category text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare k text; v uuid; m uuid; lbl text;
begin
  lbl := nullif(regexp_replace(trim(coalesce(p_label,'')), '\s+', ' ', 'g'), '');
  if lbl is null then return null; end if;
  k := cx.dish_key(lbl);
  if k = '' then return null; end if;
  select dish_id into v from public.dish_aliases where alias_key = k;
  if v is null then
    insert into public.dish_catalog(canonical_name, category) values (initcap(lbl), coalesce(p_category,'other')) returning id into v;
    insert into public.dish_aliases(alias_key, dish_id, original_label) values (k, v, lbl) on conflict (alias_key) do nothing;
    select dish_id into v from public.dish_aliases where alias_key = k;
  end if;
  loop
    select merged_into into m from public.dish_catalog where id = v;
    exit when m is null;
    v := m;
  end loop;
  return v;
end $$;

create or replace function cx._comp(p_role text, p_cat text, p_label text, p_sel text, p_qty numeric default 1) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('role', p_role, 'category', p_cat, 'label', nullif(trim(p_label),''), 'selection', p_sel, 'unit_qty', coalesce(p_qty,1)) $$;

create or replace function cx._main_cat(p_label text) returns text language sql immutable set search_path = '' as $$
  select case when p_label ~* '\m(dal|daal|dhal)\M' then 'dal' else 'sabji' end $$;

-- bread label like "4 Ghee Chapati" -> component with unit_qty 4 and label "Ghee Chapati"
create or replace function cx._bread(p_text text, p_sel text) returns jsonb language sql immutable set search_path = '' as $$
  select cx._comp('bread', 'bread',
    regexp_replace(trim(p_text), '^\d+\s+', ''), p_sel,
    coalesce(nullif(substring(trim(p_text) from '^(\d+)\s'), '')::numeric, 1)) $$;

create or replace function cx.parse_line(p_item jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_id text := coalesce(p_item->>'id','');
  v_nm text := coalesce(p_item->>'name','');
  detail text; parts text[]; n int;
  variant text := 'unknown'; size text; comps jsonb := '[]'::jsonb; parsed boolean := false;
  idp text[] := string_to_array(coalesce(p_item->>'id',''), ':');
  s text; sabjis text[]; lbl text; sr text; cat text;
begin
  detail := case when position(' — ' in v_nm) > 0 then substr(v_nm, position(' — ' in v_nm) + 3) end;
  parts := case when detail is null then null else regexp_split_to_array(detail, ', ') end;
  n := coalesce(array_length(parts,1), 0);

  if v_id like 'goldmini:%' then
    variant := 'goldMini';
    sr := idp[3];
    if n = 4 then
      comps := jsonb_build_array(
        cx._bread(parts[1], 'fixed'),
        cx._comp('main', cx._main_cat(parts[2]), parts[2], 'chosen'),
        cx._comp('side', case when sr = 'sweet' then 'sweet' else 'raita' end, parts[3], 'chosen'),
        cx._comp('side', 'salad', parts[4], 'fixed'));
      parsed := true;
    end if;

  elsif v_id like 'gold:%' then
    size := case when idp[2] = 'large' then 'large' else 'medium' end;
    variant := case when size = 'large' then 'goldLarge' else 'goldMedium' end;
    sr := idp[5];
    if n = 5 then
      comps := jsonb_build_array(cx._bread(parts[1], 'chosen'));
      sabjis := regexp_split_to_array(parts[2], ' \+ ');
      foreach s in array sabjis loop
        comps := comps || cx._comp('main', cx._main_cat(s), s, 'chosen');
      end loop;
      comps := comps || cx._comp('side', 'rice', parts[3], 'fixed')
                     || cx._comp('side', case when sr = 'sweet' then 'sweet' else 'raita' end, parts[4], 'chosen')
                     || cx._comp('side', 'salad', parts[5], 'fixed');
      parsed := true;
    elsif idp[3] = 'chapati4' then comps := jsonb_build_array(cx._comp('bread','bread','Ghee Chapati','chosen',4));
    elsif idp[3] = 'paratha3' then comps := jsonb_build_array(cx._comp('bread','bread','Ghee Paratha','chosen',3));
    end if;

  elsif v_id like 'plan-standard%' then
    variant := 'standard';
    if v_id like '%:chapati' then
      if n = 3 then
        comps := jsonb_build_array(cx._bread(parts[1], 'chosen'));
        foreach s in array regexp_split_to_array(parts[2], ' \+ ') loop
          comps := comps || cx._comp('main', cx._main_cat(s), s, 'fixed');
        end loop;
        comps := comps || cx._comp('side', 'salad', parts[3], 'fixed');
        parsed := true;
      end if;
    elsif n = 4 then
      comps := jsonb_build_array(cx._bread(parts[1], 'fixed'));
      foreach s in array regexp_split_to_array(parts[2], ' \+ ') loop
        comps := comps || cx._comp('main', cx._main_cat(s), s, 'fixed');
      end loop;
      comps := comps || cx._comp('side', 'rice', parts[3], 'chosen')
                     || cx._comp('side', 'salad', parts[4], 'fixed');
      parsed := true;
    end if;

  elsif v_id like 'mini:%' then
    variant := 'mini';
    if n = 3 then
      comps := jsonb_build_array(
        case when parts[1] ~* 'rice' then cx._comp('side','rice',parts[1],'chosen') else cx._bread(parts[1],'chosen') end,
        cx._comp('main', cx._main_cat(parts[2]), parts[2], 'chosen'),
        cx._comp('side', 'salad', parts[3], 'fixed'));
      parsed := true;
    end if;

  elsif v_id in ('extra-raita','extra-salad','extra-sweet') then
    variant := 'extra';
    lbl := regexp_replace(v_nm, '\s*\([^)]*of the Day\)\s*$', '', 'i');
    comps := jsonb_build_array(cx._comp('side', substr(v_id, 7), lbl, 'chosen'));
    parsed := true;

  else
    variant := 'extra';
    if nullif(trim(v_nm),'') is not null then
      cat := case when v_nm ~* '(roti|chapati|chapatti|paratha|naan|phulka)' then 'bread' else 'other' end;
      comps := jsonb_build_array(cx._comp(case when cat = 'bread' then 'bread' else 'side' end, cat, v_nm, 'chosen'));
      parsed := true;
    end if;
  end if;

  if not parsed and detail is not null then
    comps := comps || cx._comp('main', null, detail, 'unknown');
  end if;
  return jsonb_build_object('variant', variant, 'size', size, 'parsed', parsed, 'components', comps);
exception when others then
  return jsonb_build_object('variant','unknown','size',null,'parsed',false,'components','[]'::jsonb);
end $$;

create or replace function cx.build_snapshot(p_order_id text, p_source text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  o record; ln jsonb; idx int := 0; pr jsonb; c jsonb; svc date; v_pub bigint;
  v_lines jsonb := '[]'::jsonb; total_ct int := 0; bad_ct int := 0; v_cov text; v_items jsonb; v_qty numeric;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then return 'missing'; end if;
  if exists (select 1 from public.order_snapshots where order_id = p_order_id) then return 'exists'; end if;
  v_items := case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end;
  svc := case when o.date ~ '^\d{4}-\d{2}-\d{2}$' then o.date::date end;
  select id into v_pub from public.menu_publications
    where service_date = svc and published_at <= o.created_at order by published_at desc limit 1;

  for ln in select * from jsonb_array_elements(v_items) loop
    pr := cx.parse_line(ln);
    v_qty := case when (ln->>'qty') ~ '^\d+(\.\d+)?$' then (ln->>'qty')::numeric else 1 end;
    v_lines := v_lines || jsonb_build_object('idx', idx, 'item_id', ln->>'id', 'item_name', ln->>'name', 'qty', v_qty, 'pr', pr);
    total_ct := total_ct + 1;
    if not (pr->>'parsed')::boolean then bad_ct := bad_ct + 1; end if;
    idx := idx + 1;
  end loop;
  v_cov := case when total_ct = 0 then 'none' when bad_ct = 0 then 'full' when bad_ct = total_ct then 'none' else 'partial' end;

  insert into public.order_snapshots(order_id, service_date, source, coverage, parser_version, raw_items, menu_publication_id)
  values (p_order_id, svc, p_source, v_cov, 'v1', v_items, v_pub);

  for ln in select * from jsonb_array_elements(v_lines) loop
    pr := ln->'pr';
    insert into public.order_snapshot_lines(order_id, line_index, item_id, item_name, qty, variant, size, parsed)
    values (p_order_id, (ln->>'idx')::int, ln->>'item_id', ln->>'item_name', (ln->>'qty')::numeric,
            pr->>'variant', pr->>'size', (pr->>'parsed')::boolean);
    for c in select * from jsonb_array_elements(pr->'components') loop
      insert into public.order_snapshot_components(order_id, line_index, role, category, dish_id, label_original, selection, unit_qty)
      values (p_order_id, (ln->>'idx')::int, c->>'role', c->>'category',
              case when c->>'selection' = 'unknown' or c->>'category' is null then null else cx.resolve_dish(c->>'label', c->>'category') end,
              c->>'label', c->>'selection', coalesce((c->>'unit_qty')::numeric, 1));
    end loop;
  end loop;
  return v_cov;
end $$;

-- delivered orders (IST dates) with their primary meal variant
create or replace function cx.delivered_set(p_phones text[]) returns table(
  order_id text, ddate date, dts timestamptz, total numeric, gross numeric, discount numeric,
  date_est boolean, variant text, size text, slot text, dow text, svc date, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with base as (
    select o.id, o.created_at, o.total,
      case when o.delivered_at is not null then (o.delivered_at at time zone 'Asia/Kolkata')::date
           when o.date ~ '^\d{4}-\d{2}-\d{2}$' then o.date::date end as ddate,
      o.delivered_at as dts,
      (o.delivered_at is null) as date_est,
      case when o.date ~ '^\d{4}-\d{2}-\d{2}$' then o.date::date end as svc,
      case when (o.extra->>'originalTotal') ~ '^-?\d+(\.\d+)?$' then (o.extra->>'originalTotal')::numeric end as orig,
      case when (o.extra->>'discount') ~ '^-?\d+(\.\d+)?$' then (o.extra->>'discount')::numeric end as disc
    from public.orders o where o.phone = any(p_phones) and o.status = 'delivered'
  ),
  pv as (
    select distinct on (l.order_id) l.order_id, l.variant, l.size
    from public.order_snapshot_lines l
    join public.variant_map vm on vm.variant = l.variant and vm.is_meal
    where l.order_id in (select id from base)
    order by l.order_id, vm.tier desc, l.line_index
  )
  select b.id, b.ddate, b.dts, b.total, coalesce(b.orig, b.total + coalesce(b.disc,0)), coalesce(b.disc,0), b.date_est,
    coalesce(pv.variant,'unknown'), pv.size,
    case when b.dts is null then 'unknown'
         when extract(hour from b.dts at time zone 'Asia/Kolkata') < (select (value #>> '{}')::int from public.cx_config where key = 'slot_cutoff_hour_ist') then 'lunch'
         else 'dinner' end,
    to_char(b.ddate, 'Dy'), b.svc, b.created_at
  from base b left join pv on pv.order_id = b.id
  where b.ddate is not null
$$;

create or replace function cx.log_error(p_customer uuid, p_order text, p_ctx text, p_err text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.analysis_errors(customer_id, order_id, context, error) values (p_customer, p_order, p_ctx, p_err);
exception when others then null;
end $$;

create or replace function cx.refresh_customer(p_customer uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_root uuid; v_phones text[]; v_as_of date := cx.today_ist();
  v_cnt int; v_first date; v_last date; v_net numeric; v_gross numeric; v_disc numeric; v_est int;
  v_vc jsonb; v_sz jsonb; v_slot jsonb; v_dow jsonb; v_usual text; v_usual_sz text; v_med numeric; v_opw numeric;
  v_win jsonb := '{}'::jsonb; v_shift text; v_cov jsonb; v_t30 int; v_tp30 int;
  v_d30 text; v_p30 text; v_name text; v_tower text; v_flat text; v_nodate int; o record;
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

  -- make sure every order of this customer has an immutable snapshot (no-op if present)
  for o in select id from public.orders where phone = any(v_phones)
           and not exists (select 1 from public.order_snapshots s where s.order_id = orders.id) loop
    begin perform cx.build_snapshot(o.id, 'backfill_from_order_items');
    exception when others then perform cx.log_error(v_root, o.id, 'build_snapshot', sqlerrm); end;
  end loop;

  select count(*), min(ddate), max(ddate), coalesce(sum(total),0), coalesce(sum(gross),0), coalesce(sum(discount),0),
         count(*) filter (where date_est)
    into v_cnt, v_first, v_last, v_net, v_gross, v_disc, v_est
  from cx.delivered_set(v_phones);

  select count(*) into v_nodate from public.orders o where o.phone = any(v_phones) and o.status = 'delivered'
    and o.delivered_at is null and o.date !~ '^\d{4}-\d{2}-\d{2}$';

  select coalesce(jsonb_object_agg(variant, c), '{}') into v_vc from (select variant, count(*) c from cx.delivered_set(v_phones) group by 1) s;
  select coalesce(jsonb_object_agg(size, c), '{}') into v_sz from (select size, count(*) c from cx.delivered_set(v_phones) where size is not null and variant like 'gold%' group by 1) s;
  select coalesce(jsonb_object_agg(slot, c), '{}') into v_slot from (select slot, count(*) c from cx.delivered_set(v_phones) group by 1) s;
  select coalesce(jsonb_object_agg(dow, c), '{}') into v_dow from (select dow, count(*) c from cx.delivered_set(v_phones) group by 1) s;

  select variant into v_usual from (select variant, count(*) c, max(ddate) l from cx.delivered_set(v_phones) where variant not in ('unknown') group by 1) s order by c desc, l desc, variant limit 1;
  select size into v_usual_sz from (select size, count(*) c, max(ddate) l from cx.delivered_set(v_phones) where size is not null and variant like 'gold%' group by 1) s order by c desc, l desc limit 1;

  select percentile_cont(0.5) within group (order by gap) into v_med from (
    select ddate - lag(ddate) over (order by ddate) as gap from (select distinct ddate from cx.delivered_set(v_phones)) d) g where gap is not null;
  v_opw := case when v_cnt > 0 then round(v_cnt / greatest(1, ceil(((v_last - v_first) + 1) / 7.0)), 2) end;

  -- trailing windows (inclusive, IST calendar days)
  select jsonb_object_agg(w.win, jsonb_build_object('from', w.lo, 'to', w.hi, 'orders', coalesce(x.n,0), 'spend', coalesce(x.s,0), 'variants', coalesce(x.v,'{}'::jsonb)))
  into v_win
  from (values ('d30', v_as_of - 29, v_as_of), ('prev30', v_as_of - 59, v_as_of - 30), ('d90', v_as_of - 89, v_as_of)) as w(win, lo, hi)
  left join lateral (
    select count(*)::int n, sum(total) s,
      (select coalesce(jsonb_object_agg(variant, c), '{}') from (select variant, count(*) c from cx.delivered_set(v_phones) q where q.ddate between w.lo and w.hi group by 1) z) v
    from cx.delivered_set(v_phones) d where d.ddate between w.lo and w.hi) x on true;

  v_t30 := (v_win->'d30'->>'orders')::int; v_tp30 := (v_win->'prev30'->>'orders')::int;
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

  -- dish stats: rebuilt from scratch every time => safe to rerun, never double-counts
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

  -- selection rates: only where the menu in effect at order time was recorded and the variant offered a sabji choice
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

create or replace function cx.refresh_all(p_trigger text default 'manual') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; v_run bigint; v_n int := 0; v_e int := 0; res jsonb;
begin
  insert into public.analysis_runs(trigger) values (p_trigger) returning id into v_run;
  -- identities for every phone we know about (never merges anyone)
  for r in select phone, max(name) n, max(tower) t, max(flat) f from (
      select phone, name, tower, flat from public.customers union all
      select phone, customer_name, tower, flat from public.orders) q
    where coalesce(trim(phone),'') <> '' group by phone loop
    perform cx.ensure_identity(r.phone, r.n, r.t, r.f);
  end loop;
  for r in select id from public.customer_identities where merged_into is null loop
    res := cx.refresh_customer(r.id);
    v_n := v_n + 1;
    if not coalesce((res->>'ok')::boolean, false) then v_e := v_e + 1; end if;
  end loop;
  update public.analysis_runs set finished_at = now(), customers_refreshed = v_n, errors = v_e where id = v_run;
  return jsonb_build_object('ok', v_e = 0, 'customers_refreshed', v_n, 'errors', v_e, 'run_id', v_run);
end $$;

revoke all on all functions in schema cx from public, anon, authenticated;