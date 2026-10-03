create or replace function cx.delivered_all() returns table(order_id text, root uuid, tower text, ddate date, total numeric, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with recursive g(id, root, phone_raw) as (
    select id, id, phone_raw from public.customer_identities where merged_into is null
    union all select c.id, g.root, c.phone_raw from public.customer_identities c join g on c.merged_into = g.id)
  select o.id, g.root, coalesce(nullif(trim(upper(o.tower)), ''), 'Unknown'),
    case when o.delivered_at is not null then (o.delivered_at at time zone 'Asia/Kolkata')::date
         when o.date ~ '^\d{4}-\d{2}-\d{2}$' then o.date::date end,
    o.total, o.created_at
  from public.orders o join g on g.phone_raw = o.phone where o.status = 'delivered'
$$;

create or replace function cx.dominant_variant(p jsonb) returns text language sql stable security definer set search_path = '' as $$
  select e.key from jsonb_each_text(coalesce(p, '{}'::jsonb)) e join public.variant_map vm on vm.variant = e.key and vm.is_meal
  order by e.value::int desc, vm.tier desc limit 1 $$;

create or replace function public.staff_report_customer_metrics(p_days int default 30) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := cx.today_ist(); v_days int := greatest(1, least(coalesce(p_days, 30), 180));
  v_from date; v_pto date; v_pfrom date; v_menu jsonb; v_sup int; v_rows jsonb; r record;
  v_nvr jsonb; v_towers jsonb; v_pv jsonb; v_pmain jsonb; v_pside jsonb; v_pbread jsonb; v_up jsonb; v_down jsonb; v_shift jsonb;
  v_l713 jsonb; v_l14 jsonb; v_dups jsonb; v_missing jsonb; v_pri jsonb := '[]'::jsonb; v_cand jsonb := '[]'::jsonb;
  n int; ev jsonb; sc numeric; tw record;
begin
  perform cx.require_staff();
  for r in select i.id from public.customer_identities i left join public.customer_analysis a on a.customer_id = i.id
           where i.merged_into is null and (a.customer_id is null or a.as_of_date < v_today) loop
    perform cx.refresh_customer(r.id);
  end loop;
  v_from := v_today - (v_days - 1); v_pto := v_from - 1; v_pfrom := v_pto - (v_days - 1);
  select (value #>> '{}')::int into v_sup from public.cx_config where key = 'recent_contact_suppress_days';
  v_menu := cx.next_menu();
  select coalesce(jsonb_agg(cx.customer_summary(i.id, v_today, v_menu, coalesce(v_sup, 7))), '[]') into v_rows from public.customer_identities i where i.merged_into is null;

  with d as (select * from cx.delivered_all() where ddate is not null),
       f as (select root, min(ddate) first_d, count(*) n from d group by root),
       w as (select root, count(*) n, sum(total) rev from d where ddate between v_from and v_today group by root)
  select jsonb_build_object('window_days', v_days, 'from', v_from, 'to', v_today,
    'new_customers', count(*) filter (where f.first_d >= v_from), 'repeat_customers', count(*) filter (where f.first_d < v_from),
    'new_orders', coalesce(sum(w.n) filter (where f.first_d >= v_from), 0), 'repeat_orders', coalesce(sum(w.n) filter (where f.first_d < v_from), 0),
    'new_revenue', coalesce(sum(w.rev) filter (where f.first_d >= v_from), 0), 'repeat_revenue', coalesce(sum(w.rev) filter (where f.first_d < v_from), 0),
    'lifetime_one_time_customers', (select count(*) from f where n = 1), 'lifetime_repeat_customers', (select count(*) from f where n >= 2),
    'definition', 'New = first-ever delivered order falls inside the window. Repeat = had a delivered order before the window and ordered again inside it.')
  into v_nvr from w join f on f.root = w.root;
  v_nvr := coalesce(v_nvr, jsonb_build_object('window_days', v_days, 'from', v_from, 'to', v_today, 'new_customers', 0, 'repeat_customers', 0));

  select coalesce(jsonb_agg(c order by (c->>'net_spend')::numeric desc), '[]') into v_l713 from jsonb_array_elements(v_rows) c where c->>'bucket' = 'inactive_7_13';
  select coalesce(jsonb_agg(c order by (c->>'net_spend')::numeric desc), '[]') into v_l14 from jsonb_array_elements(v_rows) c where c->>'bucket' = 'inactive_14_plus';
  select coalesce(jsonb_agg(jsonb_build_object('id', c->>'id', 'name', c->>'name', 'phone', c->>'phone', 'tower', c->>'tower', 'flat', c->>'flat', 'days_since', c->'days_since',
     'last_delivered', c->>'last_delivered', 'delivered_orders', c->'delivered_orders', 'net_spend', c->'net_spend', 'consent', c->>'consent', 'suggestion', c->'suggestion')
     order by (c->>'net_spend')::numeric desc), '[]') into v_l713 from jsonb_array_elements(v_l713) c;
  select coalesce(jsonb_agg(jsonb_build_object('id', c->>'id', 'name', c->>'name', 'phone', c->>'phone', 'tower', c->>'tower', 'flat', c->>'flat', 'days_since', c->'days_since',
     'last_delivered', c->>'last_delivered', 'delivered_orders', c->'delivered_orders', 'net_spend', c->'net_spend', 'consent', c->>'consent', 'suggestion', c->'suggestion')
     order by (c->>'net_spend')::numeric desc), '[]') into v_l14 from jsonb_array_elements(v_l14) c;

  with d as (select * from cx.delivered_all() where ddate is not null)
  select coalesce(jsonb_agg(jsonb_build_object('tower', tower, 'delivered_orders', n, 'revenue', rev, 'customers', cust, 'last_delivery', last_d,
      'days_since_last', v_today - last_d, 'orders_window', nw, 'revenue_window', rw, 'orders_prev_window', np) order by rev desc), '[]') into v_towers
  from (select tower, count(*) n, sum(total) rev, count(distinct root) cust, max(ddate) last_d,
          count(*) filter (where ddate between v_from and v_today) nw, coalesce(sum(total) filter (where ddate between v_from and v_today), 0) rw,
          count(*) filter (where ddate between v_pfrom and v_pto) np from d group by tower) t;

  with d as (select * from cx.delivered_all() where ddate is not null)
  select coalesce(jsonb_agg(jsonb_build_object('variant', variant, 'label', label, 'orders_window', ow, 'units_window', uw, 'orders_lifetime', ol, 'units_lifetime', ul) order by ol desc), '[]') into v_pv
  from (select l.variant, vm.label, count(distinct l.order_id) filter (where d.ddate between v_from and v_today) ow,
          coalesce(sum(l.qty) filter (where d.ddate between v_from and v_today), 0) uw, count(distinct l.order_id) ol, sum(l.qty) ul
        from public.order_snapshot_lines l join d on d.order_id = l.order_id join public.variant_map vm on vm.variant = l.variant group by l.variant, vm.label) x;

  with d as (select * from cx.delivered_all() where ddate is not null)
  select coalesce(jsonb_agg(jsonb_build_object('name', nm, 'category', category, 'orders_window', ow, 'qty_window', qw, 'orders_lifetime', ol, 'chosen_orders_lifetime', ch) order by ol desc, nm), '[]') into v_pmain
  from (select dc.canonical_name nm, dc.category, count(distinct c.order_id) filter (where d.ddate between v_from and v_today) ow,
          coalesce(sum(c.unit_qty * l.qty) filter (where d.ddate between v_from and v_today), 0) qw, count(distinct c.order_id) ol,
          count(distinct c.order_id) filter (where c.selection = 'chosen') ch
        from public.order_snapshot_components c join d on d.order_id = c.order_id
        join public.order_snapshot_lines l on l.order_id = c.order_id and l.line_index = c.line_index
        join public.dish_catalog dc on dc.id = c.dish_id where c.role = 'main' group by 1, 2 order by ol desc, nm limit 10) x;
  with d as (select * from cx.delivered_all() where ddate is not null)
  select coalesce(jsonb_agg(jsonb_build_object('name', nm, 'category', category, 'orders_window', ow, 'qty_window', qw, 'orders_lifetime', ol, 'chosen_orders_lifetime', ch) order by ol desc, nm), '[]') into v_pside
  from (select dc.canonical_name nm, dc.category, count(distinct c.order_id) filter (where d.ddate between v_from and v_today) ow,
          coalesce(sum(c.unit_qty * l.qty) filter (where d.ddate between v_from and v_today), 0) qw, count(distinct c.order_id) ol,
          count(distinct c.order_id) filter (where c.selection = 'chosen') ch
        from public.order_snapshot_components c join d on d.order_id = c.order_id
        join public.order_snapshot_lines l on l.order_id = c.order_id and l.line_index = c.line_index
        join public.dish_catalog dc on dc.id = c.dish_id where c.role = 'side' and dc.category in ('raita','sweet','rice','salad') group by 1, 2 order by ol desc, nm limit 10) x;
  with d as (select * from cx.delivered_all() where ddate is not null)
  select coalesce(jsonb_agg(jsonb_build_object('name', nm, 'category', category, 'orders_window', ow, 'qty_window', qw, 'orders_lifetime', ol, 'chosen_orders_lifetime', ch) order by ol desc, nm), '[]') into v_pbread
  from (select dc.canonical_name nm, dc.category, count(distinct c.order_id) filter (where d.ddate between v_from and v_today) ow,
          coalesce(sum(c.unit_qty * l.qty) filter (where d.ddate between v_from and v_today), 0) qw, count(distinct c.order_id) ol,
          count(distinct c.order_id) filter (where c.selection = 'chosen') ch
        from public.order_snapshot_components c join d on d.order_id = c.order_id
        join public.order_snapshot_lines l on l.order_id = c.order_id and l.line_index = c.line_index
        join public.dish_catalog dc on dc.id = c.dish_id where c.role = 'bread' group by 1, 2 order by ol desc, nm limit 10) x;

  select coalesce(jsonb_object_agg(k, cnt), '{}') into v_shift from (select c->>'variant_shift' k, count(*) cnt from jsonb_array_elements(v_rows) c where c->>'variant_shift' is not null group by 1) s;
  select coalesce(jsonb_agg(jsonb_build_object('id', c->>'id', 'name', c->>'name', 'tower', c->>'tower',
       'from_variant', cx.dominant_variant(c->'windows'->'prev30'->'variants'), 'to_variant', cx.dominant_variant(c->'windows'->'d30'->'variants'))), '[]') into v_up
    from jsonb_array_elements(v_rows) c where c->>'variant_shift' = 'up';
  select coalesce(jsonb_agg(jsonb_build_object('id', c->>'id', 'name', c->>'name', 'tower', c->>'tower',
       'from_variant', cx.dominant_variant(c->'windows'->'prev30'->'variants'), 'to_variant', cx.dominant_variant(c->'windows'->'d30'->'variants'))), '[]') into v_down
    from jsonb_array_elements(v_rows) c where c->>'variant_shift' = 'down';

  v_dups := public.staff_duplicate_candidates();
  select jsonb_build_object(
    'customers', jsonb_array_length(v_rows),
    'customers_missing_tower', (select count(*) from jsonb_array_elements(v_rows) c where coalesce(trim(c->>'tower'), '') = ''),
    'customers_missing_name', (select count(*) from jsonb_array_elements(v_rows) c where coalesce(trim(c->>'name'), '') = ''),
    'customers_missing_society', (select count(*) from jsonb_array_elements(v_rows) c where coalesce(trim(c->>'society'), '') = ''),
    'customers_without_confirmed_preferences', (select count(*) from jsonb_array_elements(v_rows) c where c->'confirmed' = '{}'::jsonb and (c->>'delivered_orders')::int > 0),
    'customers_without_preference_form', (select count(*) from jsonb_array_elements(v_rows) c where c->>'form_status' = 'none' and (c->>'delivered_orders')::int > 0),
    'customers_consent_unknown', (select count(*) from jsonb_array_elements(v_rows) c where c->>'consent' = 'unknown' and (c->>'delivered_orders')::int > 0),
    'customers_consent_needs_review', (select count(*) from jsonb_array_elements(v_rows) c where (c->>'consent_needs_review')::boolean),
    'delivered_orders', (select count(*) from public.orders where status = 'delivered'),
    'delivered_orders_without_delivered_timestamp', (select count(*) from public.orders where status = 'delivered' and delivered_at is null),
    'delivered_orders_without_customer_phone', (select count(*) from public.orders where status = 'delivered' and coalesce(trim(phone), '') = ''),
    'delivered_orders_snapshot_not_full', (select count(*) from public.orders o left join public.order_snapshots s on s.order_id = o.id where o.status = 'delivered' and coalesce(s.coverage, 'none') <> 'full'),
    'delivered_orders_without_menu_record', (select count(*) from public.orders o left join public.order_snapshots s on s.order_id = o.id where o.status = 'delivered' and s.menu_publication_id is null),
    'snapshots_needing_review', (select count(*) from public.order_snapshots where needs_review),
    'unresolved_analysis_errors', (select count(*) from public.analysis_errors where resolved_at is null)) into v_missing;

  -- priorities: collect candidates with a score, keep the top three
  select count(*), coalesce(jsonb_agg(txt), '[]') into n, ev from (select format('%s (%s): %s unresolved complaint(s), %s days since last delivery', c->>'name', coalesce(c->>'tower', 'tower unknown'), c->>'complaints', coalesce(c->>'days_since', 'n/a')) txt
    from jsonb_array_elements(v_rows) c where (c->>'complaints')::int > 0 order by (c->>'complaints')::int desc limit 5) q;
  select count(*) into n from jsonb_array_elements(v_rows) c where (c->>'complaints')::int > 0;
  if n > 0 then
    v_cand := v_cand || jsonb_build_object('score', 1000000 + n, 'item', jsonb_build_object('key', 'complaints', 'title', format('Resolve %s customer complaint(s) before any promotion', n),
      'action', 'Contact each customer about the issue first; hold promotional messages until it is resolved.', 'evidence', ev));
  end if;

  select count(*), coalesce(sum((c->>'net_spend')::numeric), 0) into n, sc from jsonb_array_elements(v_rows) c
    where c->>'bucket' = 'inactive_14_plus' and (c->>'delivered_orders')::int >= 3 and c->>'consent' <> 'opted_out';
  if n > 0 then
    select coalesce(jsonb_agg(txt), '[]') into ev from (select format('%s (%s): %s delivered orders, ₹%s spent, %s days inactive', c->>'name', coalesce(c->>'tower', 'tower unknown'), c->>'delivered_orders', c->>'net_spend', c->>'days_since') txt
      from jsonb_array_elements(v_rows) c where c->>'bucket' = 'inactive_14_plus' and (c->>'delivered_orders')::int >= 3 and c->>'consent' <> 'opted_out' order by (c->>'net_spend')::numeric desc limit 5) q;
    v_cand := v_cand || jsonb_build_object('score', sc, 'item', jsonb_build_object('key', 'lapsed_regulars', 'title', format('Win back %s previously regular customer(s) inactive 14+ days', n),
      'action', 'Send a personal feedback check-in first; only suggest an offer after they reply. Together they spent ₹' || sc || '.', 'evidence', ev));
  end if;

  select count(*), coalesce(sum((c->>'net_spend')::numeric), 0) into n, sc from jsonb_array_elements(v_rows) c
    where c->>'bucket' = 'inactive_7_13' and c->'suggestion'->>'action' in ('menu_reminder', 'gentle_reminder');
  if n > 0 then
    select coalesce(jsonb_agg(txt), '[]') into ev from (select format('%s (%s): %s days inactive; %s', c->>'name', coalesce(c->>'tower', 'tower unknown'), c->>'days_since', c->'suggestion'->>'label') txt
      from jsonb_array_elements(v_rows) c where c->>'bucket' = 'inactive_7_13' and c->'suggestion'->>'action' in ('menu_reminder', 'gentle_reminder') order by (c->>'net_spend')::numeric desc limit 5) q;
    v_cand := v_cand || jsonb_build_object('score', sc * 0.6, 'item', jsonb_build_object('key', 'recent_lapse', 'title', format('Gentle reminders for %s customer(s) inactive 7–13 days', n),
      'action', 'Send the draft reminder (with a dish from the published menu where one matches). Nothing is sent automatically.', 'evidence', ev));
  end if;

  select t->>'tower' as tower, (t->>'orders_window')::int as ow, (t->>'orders_prev_window')::int as op into tw
    from jsonb_array_elements(v_towers) t where (t->>'orders_prev_window')::int - (t->>'orders_window')::int >= 2
    order by (t->>'orders_prev_window')::int - (t->>'orders_window')::int desc limit 1;
  if tw.tower is not null then
    v_cand := v_cand || jsonb_build_object('score', (tw.op - tw.ow) * 150, 'item', jsonb_build_object('key', 'tower_decline', 'title', format('Tower %s is slowing down', tw.tower),
      'action', 'Review customers in this tower on the Reactivation tab and consider a tower-specific check-in.',
      'evidence', jsonb_build_array(format('%s delivered orders in the last %s days vs %s in the %s days before', tw.ow, v_days, tw.op, v_days))));
  end if;

  select count(*) into n from jsonb_array_elements(v_rows) c where c->>'bucket' = 'active_0_6' and c->'confirmed' = '{}'::jsonb and c->>'form_status' = 'none';
  if n > 0 then
    v_cand := v_cand || jsonb_build_object('score', n * 20, 'item', jsonb_build_object('key', 'collect_preferences', 'title', format('Invite %s active customer(s) to share food preferences', n),
      'action', 'Copy each customer''s secure form link from their profile and share it manually. Preferences power better reminders.',
      'evidence', jsonb_build_array(format('%s customers ordered in the last 6 days but have no confirmed preferences and have not seen the form', n))));
  end if;

  select coalesce(jsonb_agg(x->'item' order by (x->>'score')::numeric desc), '[]') into v_pri from (select x from jsonb_array_elements(v_cand) x order by (x->>'score')::numeric desc limit 3) q;

  return jsonb_build_object('as_of', v_today, 'window', jsonb_build_object('days', v_days, 'from', v_from, 'to', v_today, 'prev_from', v_pfrom, 'prev_to', v_pto),
    'new_vs_repeat', v_nvr, 'inactive_7_13', v_l713, 'inactive_14_plus', v_l14, 'towers', v_towers,
    'popular', jsonb_build_object('variants', v_pv, 'main_dishes', v_pmain, 'sides', v_pside, 'breads', v_pbread),
    'variant_changes', jsonb_build_object('basis', 'Dominant meal variant in the last 30 days vs the 30 days before, compared with the tier order in variant_map (mini < standard < goldMini < goldMedium < goldLarge).',
       'counts', v_shift, 'upgrades', v_up, 'downgrades', v_down),
    'duplicate_candidates', jsonb_build_object('count', jsonb_array_length(v_dups), 'pairs', v_dups),
    'missing_data', v_missing, 'priorities', v_pri,
    'spend_definition', 'Revenue = sum of orders.total for delivered orders (after promo/referral discounts; the app records no delivery charge; refunds are not recorded on orders).');
end $$;

revoke all on all functions in schema cx from public, anon, authenticated;
revoke execute on function public.staff_report_customer_metrics(int) from public, anon;
grant execute on function public.staff_report_customer_metrics(int) to authenticated;