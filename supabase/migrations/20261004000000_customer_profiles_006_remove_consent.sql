-- Remove the WhatsApp marketing-consent feature entirely.
-- Functions are redefined without consent logic first, then the consent objects are dropped.

create or replace function cx.suggest(p jsonb) returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_days int := nullif(p->>'days_since','')::int; v_bucket text := p->>'bucket';
  n int := coalesce((p->>'delivered_orders')::int, 0);
  v_away date := nullif(p->>'away_until','')::date; v_fu date := nullif(p->>'follow_up','')::date;
  v_lastc date := nullif(p->>'last_contact_date','')::date; v_lastch text := p->>'last_contact_channel';
  v_compl int := coalesce((p->>'complaints')::int, 0);
  v_today date := (p->>'today')::date; v_sup int := coalesce((p->>'suppress_days')::int, 7);
  v_conf text := nullif(p->>'confirmed_match',''); v_mdl text := nullif(p->>'delivered_match',''); v_mdate text := nullif(p->>'menu_date','');
  v_regular boolean := n >= 4;
begin
  if v_bucket = 'no_delivered' then
    return jsonb_build_object('action','never_ordered','label','Never ordered','reason','No delivered orders yet, so this is not a reactivation case.','priority',90);
  end if;
  if v_bucket = 'active_0_6' then
    return jsonb_build_object('action','none','label','Active','reason', format('Last delivery %s day(s) ago.', v_days),'priority',100);
  end if;
  if v_away is not null and v_away >= v_today then
    return jsonb_build_object('action','defer','label','Defer follow-up','reason', format('Customer is away until %s (confirmed).', v_away),'priority',80);
  end if;
  if v_fu is not null and v_fu >= v_today then
    return jsonb_build_object('action','defer','label','Follow-up already scheduled','reason', format('Next follow-up is set for %s; do not contact before then.', v_fu),'priority',81);
  end if;
  if v_lastc is not null and v_lastc >= v_today - v_sup then
    return jsonb_build_object('action','wait','label','Recently contacted','reason', format('Contacted on %s via %s; wait %s days before suggesting contact again.', v_lastc, coalesce(v_lastch,'unknown channel'), v_sup),'priority',82);
  end if;
  if v_compl > 0 then
    return jsonb_build_object('action','resolve_first','label','Resolve the issue first',
      'reason', format('%s unresolved complaint(s)%s, %s days inactive. Resolve before any promotional offer.', v_compl,
        case when v_regular then ' from a previously regular customer (' || n || ' delivered orders)' else '' end, v_days),
      'priority', 1, 'draft', 'checkin');
  end if;
  if v_bucket = 'inactive_7_13' then
    if v_conf is not null and v_mdate is not null then
      return jsonb_build_object('action','menu_reminder','label','Send a personal menu reminder',
        'reason', format('Confirmed favourite %s, %s days inactive, and %s is on the published menu for %s.', v_conf, v_days, v_conf, v_mdate),
        'priority', 10, 'draft','reminder', 'dish', v_conf, 'dish_basis','confirmed', 'menu_date', v_mdate);
    elsif v_mdl is not null and v_mdate is not null then
      return jsonb_build_object('action','menu_reminder','label','Send a menu reminder',
        'reason', format('Most delivered dish is %s (not a confirmed favourite); %s days inactive; it is on the published menu for %s.', v_mdl, v_days, v_mdate),
        'priority', 20, 'draft','reminder', 'dish', v_mdl, 'dish_basis','most_delivered', 'menu_date', v_mdate);
    else
      return jsonb_build_object('action','gentle_reminder','label','Send a gentle reminder',
        'reason', format('%s days since the last delivery. No confirmed or most-delivered dish appears on a published menu%s.', v_days,
           case when v_mdate is null then ' (no menu is published for today or later)' else '' end),
        'priority', 30, 'draft','reminder');
    end if;
  end if;
  return jsonb_build_object('action','checkin','label','Personal check-in',
    'reason', format('%s days inactive%s. Ask for feedback before suggesting any offer.', v_days,
       case when v_regular then ', previously regular (' || n || ' delivered orders)' else '' end),
    'priority', case when v_regular then 5 else 40 end, 'draft','checkin');
end $$;

create or replace function public.pref_form_get(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.preference_form_tokens; v_root uuid; v_name text; prefs jsonb; v_main jsonb; v_side jsonb; v_obs jsonb;
begin
  t := cx.form_token(p_token);
  if t.id is null then return jsonb_build_object('ok', false, 'error', 'invalid_or_expired'); end if;
  v_root := cx.root_of(t.customer_id);
  select split_part(trim(coalesce(display_name,'')), ' ', 1) into v_name from public.customer_identities where id = v_root;
  select coalesce(jsonb_object_agg(field, value), '{}') into prefs from public.customer_prefs_current
    where customer_id = v_root and field in ('fav_dishes','fav_sides','disliked_dishes','spice','oil','bread_pref','portion_pref','usual_meal');
  select coalesce(jsonb_agg(jsonb_build_object('dish_id', id, 'label', canonical_name) order by canonical_name), '[]') into v_main
    from public.dish_catalog dc where dc.merged_into is null and dc.category in ('sabji','dal')
      and exists (select 1 from public.order_snapshot_components c where c.dish_id = dc.id and c.selection <> 'unknown'
                  union all select 1 from public.menu_publication_dishes m where m.dish_id = dc.id);
  select coalesce(jsonb_agg(jsonb_build_object('dish_id', id, 'label', canonical_name) order by canonical_name), '[]') into v_side
    from public.dish_catalog dc where dc.merged_into is null and dc.category in ('rice','raita','sweet','salad','bread')
      and exists (select 1 from public.order_snapshot_components c where c.dish_id = dc.id and c.selection <> 'unknown'
                  union all select 1 from public.menu_publication_dishes m where m.dish_id = dc.id);
  select jsonb_build_object(
    'mains', coalesce((select jsonb_agg(n order by o desc) from (select dc.canonical_name n, s.delivered_orders o from public.customer_dish_stats s join public.dish_catalog dc on dc.id = s.dish_id where s.customer_id = v_root and s.win = 'lifetime' and s.role_group = 'main' order by s.delivered_orders desc, s.last_date desc limit 3) x), '[]'),
    'sides', coalesce((select jsonb_agg(n order by o desc) from (select dc.canonical_name n, s.delivered_orders o from public.customer_dish_stats s join public.dish_catalog dc on dc.id = s.dish_id where s.customer_id = v_root and s.win = 'lifetime' and s.role_group = 'side' and dc.category in ('raita','sweet') order by s.delivered_orders desc, s.last_date desc limit 3) x), '[]'))
  into v_obs;
  return jsonb_build_object('ok', true, 'first_name', nullif(v_name,''), 'answers', prefs,
    'main_options', v_main, 'side_options', v_side, 'observed', v_obs);
end $$;

drop function if exists public.pref_form_save(text, jsonb, text);
create or replace function public.pref_form_save(p_token text, p_answers jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.preference_form_tokens; v_root uuid; v_src text; f text; v_fb text; v_changed int := 0; r text;
begin
  t := cx.form_token(p_token);
  if t.id is null then return jsonb_build_object('ok', false, 'error', 'invalid_or_expired'); end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' or length(p_answers::text) > 8000 then
    return jsonb_build_object('ok', false, 'error', 'bad_request');
  end if;
  v_root := cx.root_of(t.customer_id);
  v_src := case t.kind when 'staff_link' then 'customer_form_staff_link' else 'customer_form_order_link' end;
  foreach f in array array['fav_dishes','fav_sides','disliked_dishes','spice','oil','bread_pref','portion_pref','usual_meal'] loop
    if p_answers ? f then
      r := cx.set_pref(v_root, f, p_answers->f, v_src, 'customer', 'Customer preference form');
      if r <> 'unchanged' then v_changed := v_changed + 1; end if;
    end if;
  end loop;
  v_fb := cx.clean_text(p_answers->>'feedback', 1000);
  if v_fb <> '' then
    insert into public.customer_feedback(customer_id, kind, body, source, created_by) values (v_root, 'feedback', v_fb, v_src, 'customer');
  end if;
  insert into public.preference_form_submissions(customer_id, token_id, token_kind, skipped, answers)
  values (v_root, t.id, t.kind, false, p_answers - 'feedback');
  return jsonb_build_object('ok', true, 'changed', v_changed);
end $$;
revoke execute on function public.pref_form_save(text, jsonb) from public;
grant execute on function public.pref_form_save(text, jsonb) to anon, authenticated, service_role;

create or replace function cx.customer_summary(p_root uuid, p_today date, p_menu jsonb, p_sup int) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  i record; a record; v_ids uuid[]; v_days int; v_bucket text; v_plain jsonb; v_meta jsonb;
  v_compl int; lc record; v_fu date; v_tm jsonb; v_ts jsonb; v_cm jsonb; v_cs jsonb; v_conf text; v_mdl text; v_dl uuid[];
  v_form text; v_menu_ids uuid[]; v_menu_date date; v_sug jsonb; v_dup boolean; v_fav_names jsonb;
begin
  select * into i from public.customer_identities where id = p_root;
  select * into a from public.customer_analysis where customer_id = p_root;
  v_ids := cx.group_ids(p_root);
  v_menu_date := nullif(p_menu->>'date','')::date;
  v_menu_ids := array(select (jsonb_array_elements_text(coalesce(p_menu->'ids','[]')))::uuid);

  v_days := case when a.last_delivered_date is null then null else greatest(0, p_today - a.last_delivered_date) end;
  v_bucket := case when v_days is null then 'no_delivered' when v_days <= 6 then 'active_0_6' when v_days <= 13 then 'inactive_7_13' else 'inactive_14_plus' end;

  select coalesce(jsonb_object_agg(field, value), '{}'), coalesce(jsonb_object_agg(field, jsonb_build_object('value', value, 'source', source, 'by', set_by, 'at', set_at)), '{}')
    into v_plain, v_meta from public.customer_prefs_current where customer_id = p_root;

  select count(*) into v_compl from public.customer_feedback where customer_id = any(v_ids) and kind = 'complaint' and status = 'open' and removed_at is null;
  select contacted_at, channel, next_follow_up into lc from public.contact_log where customer_id = any(v_ids) and removed_at is null order by contacted_at desc limit 1;
  v_fu := greatest(nullif(v_plain->>'follow_up_date','')::date, lc.next_follow_up);
  select case when bool_or(not skipped) then 'submitted' when count(*) > 0 then 'skipped' else 'none' end into v_form
    from public.preference_form_submissions where customer_id = any(v_ids);
  v_form := coalesce(v_form, 'none');

  select coalesce(jsonb_agg(jsonb_build_object('dish_id', x.dish_id, 'name', x.nm, 'orders', x.delivered_orders, 'explicit', x.explicit_orders, 'last', x.last_date, 'eligible', x.eligible_orders, 'selected_of_eligible', x.selected_of_eligible)), '[]') into v_tm
  from (select s.*, dc.canonical_name nm from public.customer_dish_stats s join public.dish_catalog dc on dc.id = s.dish_id
        where s.customer_id = p_root and s.win = 'lifetime' and s.role_group = 'main' order by s.delivered_orders desc, s.last_date desc, dc.canonical_name limit 3) x;
  select coalesce(jsonb_agg(jsonb_build_object('dish_id', x.dish_id, 'name', x.nm, 'orders', x.delivered_orders, 'explicit', x.explicit_orders, 'last', x.last_date)), '[]') into v_ts
  from (select s.*, dc.canonical_name nm from public.customer_dish_stats s join public.dish_catalog dc on dc.id = s.dish_id
        where s.customer_id = p_root and s.win = 'lifetime' and s.role_group = 'side' and dc.category in ('raita','sweet') order by s.delivered_orders desc, s.last_date desc, dc.canonical_name limit 3) x;
  select coalesce(jsonb_agg(jsonb_build_object('dish_id', x.dish_id, 'name', x.nm, 'explicit', x.explicit_orders, 'last', x.last_explicit_date)), '[]') into v_cm
  from (select s.*, dc.canonical_name nm from public.customer_dish_stats s join public.dish_catalog dc on dc.id = s.dish_id
        where s.customer_id = p_root and s.win = 'lifetime' and s.role_group = 'main' and s.explicit_orders > 0 order by s.explicit_orders desc, s.last_explicit_date desc, dc.canonical_name limit 3) x;
  select coalesce(jsonb_agg(jsonb_build_object('dish_id', x.dish_id, 'name', x.nm, 'explicit', x.explicit_orders, 'last', x.last_explicit_date)), '[]') into v_cs
  from (select s.*, dc.canonical_name nm from public.customer_dish_stats s join public.dish_catalog dc on dc.id = s.dish_id
        where s.customer_id = p_root and s.win = 'lifetime' and s.role_group = 'side' and dc.category in ('raita','sweet') and s.explicit_orders > 0 order by s.explicit_orders desc, s.last_explicit_date desc, dc.canonical_name limit 3) x;

  v_dl := array(select cx.canon_dish((e->>'dish_id')::uuid) from jsonb_array_elements(coalesce(v_plain->'disliked_dishes','[]'::jsonb)) e where e->>'dish_id' is not null);
  select dc.canonical_name into v_conf
  from jsonb_array_elements(coalesce(v_plain->'fav_dishes','[]'::jsonb) || coalesce(v_plain->'fav_sides','[]'::jsonb)) e
  join public.dish_catalog dc on dc.id = cx.canon_dish((e->>'dish_id')::uuid)
  where e->>'dish_id' is not null and dc.id = any(v_menu_ids) and not (dc.id = any(v_dl)) limit 1;
  select dc.canonical_name into v_mdl
  from public.customer_dish_stats s join public.dish_catalog dc on dc.id = s.dish_id
  where s.customer_id = p_root and s.win = 'lifetime' and (s.role_group = 'main' or dc.category in ('raita','sweet'))
    and s.delivered_orders >= 2 and s.dish_id = any(v_menu_ids) and not (s.dish_id = any(v_dl))
  order by s.delivered_orders desc, s.last_date desc limit 1;

  v_sug := cx.suggest(jsonb_build_object('days_since', v_days, 'bucket', v_bucket, 'delivered_orders', coalesce(a.delivered_orders, 0),
      'away_until', v_plain->>'away_until', 'follow_up', v_fu, 'last_contact_date', (lc.contacted_at at time zone 'Asia/Kolkata')::date,
      'last_contact_channel', lc.channel, 'complaints', v_compl, 'today', p_today, 'suppress_days', p_sup,
      'confirmed_match', v_conf, 'delivered_match', v_mdl, 'menu_date', v_menu_date));
  v_dup := exists (select 1 from cx.duplicate_pairs() d where d.a = p_root or d.b = p_root);

  return jsonb_build_object(
    'id', p_root, 'name', i.display_name, 'phone', i.phone_raw, 'phone_norm', i.phone_norm, 'tower', i.tower, 'flat', i.flat, 'society', i.society,
    'first_delivered', a.first_delivered_date, 'last_delivered', a.last_delivered_date, 'delivered_orders', coalesce(a.delivered_orders, 0),
    'net_spend', coalesce(a.net_spend, 0), 'gross_amount', coalesce(a.gross_amount, 0), 'discount_amount', coalesce(a.discount_amount, 0),
    'avg_order_value', a.avg_order_value, 'days_since', v_days, 'bucket', v_bucket,
    'usual_variant', a.usual_variant, 'usual_size', a.usual_size, 'variant_counts', a.variant_counts, 'size_counts', a.size_counts,
    'slot_counts', a.slot_counts, 'weekday_counts', a.weekday_counts, 'orders_per_week', a.orders_per_week, 'median_gap_days', a.median_gap_days,
    'variant_shift', a.variant_shift, 'windows', a.windows, 'coverage', a.coverage, 'as_of_date', a.as_of_date, 'refreshed_at', a.refreshed_at,
    'top_mains', v_tm, 'top_sides', v_ts, 'chosen_mains', v_cm, 'chosen_sides', v_cs,
    'confirmed', v_meta,
    'complaints', v_compl, 'last_contact_at', lc.contacted_at, 'last_contact_channel', lc.channel, 'next_follow_up', v_fu,
    'form_status', v_form, 'possible_duplicate', v_dup, 'suggestion', v_sug);
end $$;

create or replace function public.staff_customer_profile(p_customer uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_root uuid; v_today date := cx.today_ist(); v_ids uuid[]; v_phones text[]; v_menu jsonb; v_sup int; v_sum jsonb;
  v_stats jsonb; v_orders jsonb; v_log jsonb; v_fb jsonb; v_notes jsonb; v_contacts jsonb; v_subs jsonb; v_links int; v_dups jsonb; v_errs jsonb; v_merged jsonb; v_a record;
begin
  perform cx.require_staff();
  v_root := cx.root_of(p_customer);
  select * into v_a from public.customer_analysis where customer_id = v_root;
  if v_a.customer_id is null or v_a.as_of_date < v_today then perform cx.refresh_customer(v_root); end if;
  v_ids := cx.group_ids(v_root); v_phones := cx.group_phones(v_root);
  select (value #>> '{}')::int into v_sup from public.cx_config where key = 'recent_contact_suppress_days';
  v_menu := cx.next_menu();
  v_sum := cx.customer_summary(v_root, v_today, v_menu, coalesce(v_sup, 7));

  select coalesce(jsonb_agg(jsonb_build_object('dish_id', s.dish_id, 'name', dc.canonical_name, 'category', s.category, 'role_group', s.role_group, 'win', s.win,
      'delivered_orders', s.delivered_orders, 'explicit_orders', s.explicit_orders, 'fixed_orders', s.fixed_orders, 'qty', s.qty,
      'first_date', s.first_date, 'last_date', s.last_date, 'last_explicit_date', s.last_explicit_date,
      'eligible_orders', s.eligible_orders, 'selected_of_eligible', s.selected_of_eligible)
      order by s.delivered_orders desc, s.last_date desc), '[]') into v_stats
  from public.customer_dish_stats s join public.dish_catalog dc on dc.id = s.dish_id where s.customer_id = v_root;

  select coalesce(jsonb_agg(x order by (x->>'created_at') desc), '[]') into v_orders from (
    select jsonb_build_object('id', o.id, 'date', o.date, 'status', o.status, 'total', o.total, 'discount', coalesce(o.extra->>'discount', '0'),
        'delivered_at', o.delivered_at, 'created_at', o.created_at, 'tower', o.tower, 'flat', o.flat, 'phone', o.phone, 'items', o.items,
        'rating', o.extra->'rating', 'coverage', s.coverage, 'needs_review', s.needs_review, 'review_reason', s.review_reason, 'snapshot_version', s.version,
        'snapshot_source', s.source, 'corrected_by', s.corrected_by, 'menu_recorded', s.menu_publication_id is not null,
        'lines', (select coalesce(jsonb_agg(jsonb_build_object('line_index', l.line_index, 'name', l.item_name, 'qty', l.qty, 'variant', l.variant, 'size', l.size, 'parsed', l.parsed) order by l.line_index), '[]') from public.order_snapshot_lines l where l.order_id = o.id),
        'components', (select coalesce(jsonb_agg(jsonb_build_object('line_index', c.line_index, 'role', c.role, 'category', c.category, 'label', c.label_original, 'dish', dc.canonical_name, 'selection', c.selection, 'unit_qty', c.unit_qty) order by c.line_index, c.id), '[]')
                       from public.order_snapshot_components c left join public.dish_catalog dc on dc.id = c.dish_id where c.order_id = o.id)) x
    from public.orders o left join public.order_snapshots s on s.order_id = o.id
    where o.phone = any(v_phones) order by o.created_at desc limit 200) q;

  select coalesce(jsonb_agg(row_to_json(l) order by l.id desc), '[]') into v_log from (select * from public.customer_pref_log where customer_id = any(v_ids) order by id desc limit 100) l;
  select coalesce(jsonb_agg(row_to_json(f) order by f.id desc), '[]') into v_fb from (select * from public.customer_feedback where customer_id = any(v_ids) and removed_at is null order by id desc) f;
  select coalesce(jsonb_agg(row_to_json(n) order by n.id desc), '[]') into v_notes from (select * from public.customer_internal_notes where customer_id = any(v_ids) and removed_at is null order by id desc) n;
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'contacted_at', c.contacted_at, 'channel', c.channel, 'message', c.message, 'offer', c.offer, 'staff_name', c.staff_name,
      'customer_response', c.customer_response, 'inactivity_reason', c.inactivity_reason, 'next_follow_up', c.next_follow_up, 'created_by', c.created_by,
      'next_delivered_date', nx.ddate, 'ordered_within_7d', case when nx.ddate is not null and nx.ddate <= (c.contacted_at at time zone 'Asia/Kolkata')::date + 7 then 'yes'
                                                                  when v_today > (c.contacted_at at time zone 'Asia/Kolkata')::date + 7 then 'no' else 'window_open' end,
      'ordered_within_30d', case when nx.ddate is not null and nx.ddate <= (c.contacted_at at time zone 'Asia/Kolkata')::date + 30 then 'yes'
                                 when v_today > (c.contacted_at at time zone 'Asia/Kolkata')::date + 30 then 'no' else 'window_open' end) order by c.contacted_at desc), '[]') into v_contacts
  from public.contact_log c left join lateral (select d.ddate from cx.delivered_set(v_phones) d where d.dts > c.contacted_at order by d.dts limit 1) nx on true
  where c.customer_id = any(v_ids) and c.removed_at is null;
  select coalesce(jsonb_agg(jsonb_build_object('at', submitted_at, 'skipped', skipped, 'via', token_kind, 'answers', answers) order by id desc), '[]') into v_subs
    from (select * from public.preference_form_submissions where customer_id = any(v_ids) order by id desc limit 10) s;
  select count(*) into v_links from public.preference_form_tokens where customer_id = any(v_ids) and revoked_at is null and expires_at > now();
  select coalesce(jsonb_agg(jsonb_build_object('other_id', case when d.a = v_root then d.b else d.a end, 'reason', d.reason,
      'name', o.display_name, 'phone', o.phone_raw, 'tower', o.tower, 'flat', o.flat)), '[]') into v_dups
    from cx.duplicate_pairs() d join public.customer_identities o on o.id = case when d.a = v_root then d.b else d.a end where d.a = v_root or d.b = v_root;
  select coalesce(jsonb_agg(row_to_json(e) order by e.id desc), '[]') into v_errs from (select id, order_id, context, error, created_at from public.analysis_errors where customer_id = any(v_ids) and resolved_at is null order by id desc limit 10) e;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'phone', phone_raw, 'merged_at', merged_at, 'merged_by', merged_by, 'reason', merge_reason)), '[]') into v_merged
    from public.customer_identities where id = any(v_ids) and id <> v_root;

  return jsonb_build_object('summary', v_sum, 'dish_stats', v_stats, 'orders', v_orders, 'pref_log', v_log,
    'feedback', v_fb, 'notes', v_notes, 'contacts', v_contacts, 'form_submissions', v_subs, 'active_form_links', v_links,
    'duplicates', v_dups, 'errors', v_errs, 'merged_records', v_merged, 'next_menu', v_menu - 'ids', 'as_of', v_today,
    'notes_about_metrics', jsonb_build_object(
      'spend', 'Spend = sum of orders.total for delivered orders (what the customer was charged, after promo/referral discounts). The app has no delivery-charge field, so none is included. Refunds are not recorded on orders, so none are deducted; credit-ledger top-ups and debits are payment tracking and are not counted as spend.',
      'dates', 'All dates are Asia/Kolkata calendar dates, taken from the delivered timestamp (falling back to the order date only if no delivered timestamp exists).',
      'slot', 'The app has no lunch/dinner field. Slot is inferred from the delivery time (before the configured IST cut-off = lunch, otherwise dinner) and is labelled as inferred.'));
end $$;

create or replace function public.staff_merge_customers(p_from uuid, p_into uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare f record; t record; rec record; v_by text := cx.staff_email();
  v_conf jsonb := '[]'::jsonb; v_cur jsonb; v_orders int;
begin
  perform cx.require_staff();
  if p_from = p_into then raise exception 'cannot merge a customer into itself'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'a reason is required'; end if;
  select * into f from public.customer_identities where id = p_from and merged_into is null;
  select * into t from public.customer_identities where id = p_into and merged_into is null;
  if f.id is null or t.id is null then raise exception 'both customers must be active (not already merged)'; end if;

  for rec in select * from public.customer_prefs_current where customer_id = p_from loop
    select value into v_cur from public.customer_prefs_current where customer_id = p_into and field = rec.field;
    if v_cur is null then
      insert into public.customer_pref_log(customer_id, field, action, value, source, set_by, note)
      values (p_into, rec.field, 'set', rec.value, 'merge', v_by,
        format('Carried over from merged record %s (originally %s, set by %s on %s)', f.phone_raw, rec.source, rec.set_by, rec.set_at::date));
    elsif v_cur is distinct from rec.value then
      v_conf := v_conf || jsonb_build_object('field', rec.field, 'kept', v_cur, 'not_carried', rec.value);
    end if;
  end loop;

  update public.customer_identities set merged_into = p_into, merged_at = now(), merged_by = v_by, merge_reason = trim(p_reason) where id = p_from;
  select count(*) into v_orders from public.orders where phone = any(cx.group_phones(p_into));
  insert into public.customer_merge_audit(from_id, into_id, reason, merged_by, details)
  values (p_from, p_into, trim(p_reason), v_by, jsonb_build_object('from_phone', f.phone_raw, 'into_phone', t.phone_raw, 'from_name', f.display_name, 'into_name', t.display_name,
    'preference_conflicts', v_conf, 'orders_after_merge', v_orders));
  perform cx.refresh_customer(p_into);
  perform cx.refresh_customer(p_from);
  return jsonb_build_object('ok', true, 'into', p_into, 'preference_conflicts', v_conf);
end $$;

create or replace function public.staff_report_customer_metrics(p_days int default 30) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := cx.today_ist(); v_days int := greatest(1, least(coalesce(p_days, 30), 180));
  v_from date; v_pto date; v_pfrom date; v_menu jsonb; v_sup int; v_rows jsonb; r record;
  v_nvr jsonb; v_towers jsonb; v_pv jsonb; v_pmain jsonb; v_pside jsonb; v_pbread jsonb; v_up jsonb; v_down jsonb; v_shift jsonb;
  v_l713 jsonb; v_l14 jsonb; v_dups jsonb; v_missing jsonb; v_pri jsonb := '[]'::jsonb; v_cand jsonb := '[]'::jsonb;
  v_cnt int; v_ev jsonb; v_sc numeric; tw record;
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
       f as (select root, min(ddate) first_d, count(*) cnt from d group by root),
       w as (select root, count(*) cnt, sum(total) rev from d where ddate between v_from and v_today group by root)
  select jsonb_build_object('window_days', v_days, 'from', v_from, 'to', v_today,
    'new_customers', count(*) filter (where f.first_d >= v_from), 'repeat_customers', count(*) filter (where f.first_d < v_from),
    'new_orders', coalesce(sum(w.cnt) filter (where f.first_d >= v_from), 0), 'repeat_orders', coalesce(sum(w.cnt) filter (where f.first_d < v_from), 0),
    'new_revenue', coalesce(sum(w.rev) filter (where f.first_d >= v_from), 0), 'repeat_revenue', coalesce(sum(w.rev) filter (where f.first_d < v_from), 0),
    'lifetime_one_time_customers', (select count(*) from f where f.cnt = 1), 'lifetime_repeat_customers', (select count(*) from f where f.cnt >= 2),
    'definition', 'New = first-ever delivered order falls inside the window. Repeat = had a delivered order before the window and ordered again inside it.')
  into v_nvr from w join f on f.root = w.root;
  v_nvr := coalesce(v_nvr, jsonb_build_object('window_days', v_days, 'from', v_from, 'to', v_today, 'new_customers', 0, 'repeat_customers', 0));

  select coalesce(jsonb_agg(jsonb_build_object('id', c->>'id', 'name', c->>'name', 'phone', c->>'phone', 'tower', c->>'tower', 'flat', c->>'flat', 'days_since', c->'days_since',
     'last_delivered', c->>'last_delivered', 'delivered_orders', c->'delivered_orders', 'net_spend', c->'net_spend', 'suggestion', c->'suggestion')
     order by (c->>'net_spend')::numeric desc), '[]') into v_l713 from jsonb_array_elements(v_rows) c where c->>'bucket' = 'inactive_7_13';
  select coalesce(jsonb_agg(jsonb_build_object('id', c->>'id', 'name', c->>'name', 'phone', c->>'phone', 'tower', c->>'tower', 'flat', c->>'flat', 'days_since', c->'days_since',
     'last_delivered', c->>'last_delivered', 'delivered_orders', c->'delivered_orders', 'net_spend', c->'net_spend', 'suggestion', c->'suggestion')
     order by (c->>'net_spend')::numeric desc), '[]') into v_l14 from jsonb_array_elements(v_rows) c where c->>'bucket' = 'inactive_14_plus';

  with d as (select * from cx.delivered_all() where ddate is not null)
  select coalesce(jsonb_agg(jsonb_build_object('tower', tower, 'delivered_orders', cnt, 'revenue', rev, 'customers', cust, 'last_delivery', last_d,
      'days_since_last', v_today - last_d, 'orders_window', nw, 'revenue_window', rw, 'orders_prev_window', np) order by rev desc), '[]') into v_towers
  from (select tower, count(*) cnt, sum(total) rev, count(distinct root) cust, max(ddate) last_d,
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
    'delivered_orders', (select count(*) from public.orders where status = 'delivered'),
    'delivered_orders_without_delivered_timestamp', (select count(*) from public.orders where status = 'delivered' and delivered_at is null),
    'delivered_orders_without_customer_phone', (select count(*) from public.orders where status = 'delivered' and coalesce(trim(phone), '') = ''),
    'delivered_orders_snapshot_not_full', (select count(*) from public.orders o left join public.order_snapshots s on s.order_id = o.id where o.status = 'delivered' and coalesce(s.coverage, 'none') <> 'full'),
    'delivered_orders_without_menu_record', (select count(*) from public.orders o left join public.order_snapshots s on s.order_id = o.id where o.status = 'delivered' and s.menu_publication_id is null),
    'snapshots_needing_review', (select count(*) from public.order_snapshots where needs_review),
    'unresolved_analysis_errors', (select count(*) from public.analysis_errors where resolved_at is null)) into v_missing;

  select count(*) into v_cnt from jsonb_array_elements(v_rows) c where (c->>'complaints')::int > 0;
  if v_cnt > 0 then
    select coalesce(jsonb_agg(txt), '[]') into v_ev from (select format('%s (%s): %s unresolved complaint(s), %s days since last delivery', c->>'name', coalesce(c->>'tower', 'tower unknown'), c->>'complaints', coalesce(c->>'days_since', 'n/a')) txt
      from jsonb_array_elements(v_rows) c where (c->>'complaints')::int > 0 order by (c->>'complaints')::int desc limit 5) q;
    v_cand := v_cand || jsonb_build_object('score', 1000000 + v_cnt, 'item', jsonb_build_object('key', 'complaints', 'title', format('Resolve %s customer complaint(s) before any promotion', v_cnt),
      'action', 'Contact each customer about the issue first; hold promotional messages until it is resolved.', 'evidence', v_ev));
  end if;

  select count(*), coalesce(sum((c->>'net_spend')::numeric), 0) into v_cnt, v_sc from jsonb_array_elements(v_rows) c
    where c->>'bucket' = 'inactive_14_plus' and (c->>'delivered_orders')::int >= 3;
  if v_cnt > 0 then
    select coalesce(jsonb_agg(txt), '[]') into v_ev from (select format('%s (%s): %s delivered orders, ₹%s spent, %s days inactive', c->>'name', coalesce(c->>'tower', 'tower unknown'), c->>'delivered_orders', c->>'net_spend', c->>'days_since') txt
      from jsonb_array_elements(v_rows) c where c->>'bucket' = 'inactive_14_plus' and (c->>'delivered_orders')::int >= 3 order by (c->>'net_spend')::numeric desc limit 5) q;
    v_cand := v_cand || jsonb_build_object('score', v_sc, 'item', jsonb_build_object('key', 'lapsed_regulars', 'title', format('Win back %s previously regular customer(s) inactive 14+ days', v_cnt),
      'action', 'Send a personal feedback check-in first; only suggest an offer after they reply. Together they spent ₹' || v_sc || '.', 'evidence', v_ev));
  end if;

  select count(*), coalesce(sum((c->>'net_spend')::numeric), 0) into v_cnt, v_sc from jsonb_array_elements(v_rows) c
    where c->>'bucket' = 'inactive_7_13' and c->'suggestion'->>'action' in ('menu_reminder', 'gentle_reminder');
  if v_cnt > 0 then
    select coalesce(jsonb_agg(txt), '[]') into v_ev from (select format('%s (%s): %s days inactive; %s', c->>'name', coalesce(c->>'tower', 'tower unknown'), c->>'days_since', c->'suggestion'->>'label') txt
      from jsonb_array_elements(v_rows) c where c->>'bucket' = 'inactive_7_13' and c->'suggestion'->>'action' in ('menu_reminder', 'gentle_reminder') order by (c->>'net_spend')::numeric desc limit 5) q;
    v_cand := v_cand || jsonb_build_object('score', v_sc * 0.6, 'item', jsonb_build_object('key', 'recent_lapse', 'title', format('Gentle reminders for %s customer(s) inactive 7–13 days', v_cnt),
      'action', 'Send the draft reminder (with a dish from the published menu where one matches). Nothing is sent automatically.', 'evidence', v_ev));
  end if;

  select t->>'tower' as tower, (t->>'orders_window')::int as ow, (t->>'orders_prev_window')::int as op into tw
    from jsonb_array_elements(v_towers) t where (t->>'orders_prev_window')::int - (t->>'orders_window')::int >= 2
    order by (t->>'orders_prev_window')::int - (t->>'orders_window')::int desc limit 1;
  if tw.tower is not null then
    v_cand := v_cand || jsonb_build_object('score', (tw.op - tw.ow) * 150, 'item', jsonb_build_object('key', 'tower_decline', 'title', format('Tower %s is slowing down', tw.tower),
      'action', 'Review customers in this tower on the Reactivation tab and consider a tower-specific check-in.',
      'evidence', jsonb_build_array(format('%s delivered orders in the last %s days vs %s in the %s days before', tw.ow, v_days, tw.op, v_days))));
  end if;

  select count(*) into v_cnt from jsonb_array_elements(v_rows) c where c->>'bucket' = 'active_0_6' and c->'confirmed' = '{}'::jsonb and c->>'form_status' = 'none';
  if v_cnt > 0 then
    v_cand := v_cand || jsonb_build_object('score', v_cnt * 20, 'item', jsonb_build_object('key', 'collect_preferences', 'title', format('Invite %s active customer(s) to share food preferences', v_cnt),
      'action', 'Copy each customer''s secure form link from their profile and share it manually. Preferences power better reminders.',
      'evidence', jsonb_build_array(format('%s customers ordered in the last 6 days but have no confirmed preferences and have not seen the form', v_cnt))));
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
revoke execute on function public.staff_report_customer_metrics(int) from public, anon;
grant execute on function public.staff_report_customer_metrics(int) to authenticated;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('staff_customer_profile','staff_merge_customers') loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
revoke all on all functions in schema cx from public, anon, authenticated;

drop function if exists public.staff_set_consent(uuid, text, text);
drop function if exists cx.set_consent(uuid, text, text, text, text);
drop view if exists public.customer_consent_current;
drop table if exists public.marketing_consent_log;
alter table public.customer_identities drop column if exists consent_needs_review, drop column if exists consent_review_reason;