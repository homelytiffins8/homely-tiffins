create or replace function cx.group_ids(p_root uuid) returns uuid[] language sql stable security definer set search_path = '' as $$
  with recursive t as (
    select id from public.customer_identities where id = p_root
    union all
    select c.id from public.customer_identities c join t on c.merged_into = t.id)
  select array_agg(id) from t $$;

create or replace function cx.group_phones(p_root uuid) returns text[] language sql stable security definer set search_path = '' as $$
  select array_agg(phone_raw) from public.customer_identities where id = any(cx.group_ids(p_root)) $$;

create or replace function cx.next_menu() returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_date date; v_pub bigint; v_dishes jsonb;
begin
  select service_date, id into v_date, v_pub from public.menu_publications
  where service_date >= cx.today_ist() order by service_date asc, published_at desc, id desc limit 1;
  if v_pub is null then return jsonb_build_object('date', null, 'dishes', '[]'::jsonb, 'ids', '[]'::jsonb); end if;
  select coalesce(jsonb_agg(jsonb_build_object('dish_id', dc.id, 'name', dc.canonical_name, 'role', d.role, 'premium', d.premium)), '[]')
  into v_dishes
  from public.menu_publication_dishes d join public.dish_catalog dc on dc.id = cx.canon_dish(d.dish_id)
  where d.publication_id = v_pub;
  return jsonb_build_object('date', v_date, 'dishes', v_dishes, 'ids', (select coalesce(jsonb_agg(x->>'dish_id'), '[]') from jsonb_array_elements(v_dishes) x));
end $$;

create or replace function cx.customer_summary(p_root uuid, p_today date, p_menu jsonb, p_sup int) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  i record; a record; v_ids uuid[]; v_days int; v_bucket text; v_plain jsonb; v_meta jsonb; v_cons text := 'unknown'; v_cons_src text; v_cons_at timestamptz;
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
  select status, source, captured_at into v_cons, v_cons_src, v_cons_at from public.customer_consent_current where customer_id = p_root;
  v_cons := coalesce(v_cons, 'unknown');

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
      'consent', v_cons, 'away_until', v_plain->>'away_until', 'follow_up', v_fu, 'last_contact_date', (lc.contacted_at at time zone 'Asia/Kolkata')::date,
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
    'confirmed', v_meta, 'consent', v_cons, 'consent_source', v_cons_src, 'consent_at', v_cons_at,
    'consent_needs_review', i.consent_needs_review, 'consent_review_reason', i.consent_review_reason,
    'complaints', v_compl, 'last_contact_at', lc.contacted_at, 'last_contact_channel', lc.channel, 'next_follow_up', v_fu,
    'form_status', v_form, 'possible_duplicate', v_dup, 'suggestion', v_sug);
end $$;

create or replace function cx.duplicate_pairs() returns table(a uuid, b uuid, reason text)
language sql stable security definer set search_path = '' as $$
  select x.id, y.id,
    concat_ws('; ',
      case when x.phone_norm is not null and x.phone_norm = y.phone_norm then 'Same normalised phone number' end,
      case when coalesce(trim(x.display_name),'') <> '' and lower(trim(x.display_name)) = lower(trim(y.display_name))
                and coalesce(lower(trim(x.tower)),'') = coalesce(lower(trim(y.tower)),'')
                and coalesce(lower(trim(x.flat)),'') = coalesce(lower(trim(y.flat)),'') then 'Same name, tower and flat' end)
  from public.customer_identities x join public.customer_identities y on x.id < y.id
  where x.merged_into is null and y.merged_into is null
    and ((x.phone_norm is not null and x.phone_norm = y.phone_norm)
      or (coalesce(trim(x.display_name),'') <> '' and lower(trim(x.display_name)) = lower(trim(y.display_name))
          and coalesce(lower(trim(x.tower)),'') = coalesce(lower(trim(y.tower)),'')
          and coalesce(lower(trim(x.flat)),'') = coalesce(lower(trim(y.flat)),'')))
    and not exists (select 1 from public.duplicate_dismissals d where d.a = x.id and d.b = y.id)
$$;

create or replace function public.staff_customer_overview() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_today date := cx.today_ist(); r record; v_sup int; v_menu jsonb; v_rows jsonb := '[]'::jsonb; v_errs jsonb; v_run jsonb; v_fail int := 0;
begin
  perform cx.require_staff();
  for r in select i.id from public.customer_identities i left join public.customer_analysis a on a.customer_id = i.id
           where i.merged_into is null and (a.customer_id is null or a.as_of_date < v_today) loop
    perform cx.refresh_customer(r.id);
  end loop;
  select (value #>> '{}')::int into v_sup from public.cx_config where key = 'recent_contact_suppress_days';
  v_menu := cx.next_menu();
  select coalesce(jsonb_agg(cx.customer_summary(i.id, v_today, v_menu, coalesce(v_sup, 7)) order by i.display_name), '[]') into v_rows
  from public.customer_identities i where i.merged_into is null;
  select coalesce(jsonb_agg(row_to_json(e)), '[]') into v_errs from (select id, customer_id, order_id, context, error, created_at from public.analysis_errors where resolved_at is null order by id desc limit 20) e;
  select row_to_json(x)::jsonb into v_run from (select id, started_at, finished_at, trigger, customers_refreshed, errors from public.analysis_runs order by id desc limit 1) x;
  return jsonb_build_object('as_of', v_today, 'next_menu', v_menu - 'ids', 'customers', v_rows, 'errors', v_errs, 'last_run', v_run,
    'duplicate_pairs', (select count(*) from cx.duplicate_pairs()));
end $$;

create or replace function public.staff_customer_profile(p_customer uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_root uuid; v_today date := cx.today_ist(); v_ids uuid[]; v_phones text[]; v_menu jsonb; v_sup int; v_sum jsonb;
  v_stats jsonb; v_orders jsonb; v_log jsonb; v_consent_log jsonb; v_fb jsonb; v_notes jsonb; v_contacts jsonb; v_subs jsonb; v_links int; v_dups jsonb; v_errs jsonb; v_merged jsonb; v_a record;
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
  select coalesce(jsonb_agg(row_to_json(l) order by l.id desc), '[]') into v_consent_log from (select * from public.marketing_consent_log where customer_id = any(v_ids) order by id desc limit 50) l;
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

  return jsonb_build_object('summary', v_sum, 'dish_stats', v_stats, 'orders', v_orders, 'pref_log', v_log, 'consent_log', v_consent_log,
    'feedback', v_fb, 'notes', v_notes, 'contacts', v_contacts, 'form_submissions', v_subs, 'active_form_links', v_links,
    'duplicates', v_dups, 'errors', v_errs, 'merged_records', v_merged, 'next_menu', v_menu - 'ids', 'as_of', v_today,
    'notes_about_metrics', jsonb_build_object(
      'spend', 'Spend = sum of orders.total for delivered orders (what the customer was charged, after promo/referral discounts). The app has no delivery-charge field, so none is included. Refunds are not recorded on orders, so none are deducted; credit-ledger top-ups and debits are payment tracking and are not counted as spend.',
      'dates', 'All dates are Asia/Kolkata calendar dates, taken from the delivered timestamp (falling back to the order date only if no delivered timestamp exists).',
      'slot', 'The app has no lunch/dinner field. Slot is inferred from the delivery time (before the configured IST cut-off = lunch, otherwise dinner) and is labelled as inferred.'));
end $$;

-- ───────────── writes (all stamp the signed-in staff member)
create or replace function public.staff_set_pref(p_customer uuid, p_field text, p_value jsonb, p_note text default null) returns text
language plpgsql security definer set search_path = '' as $$
begin perform cx.require_staff(); return cx.set_pref(p_customer, p_field, p_value, 'staff', cx.staff_email(), cx.clean_text(p_note, 300)); end $$;

create or replace function public.staff_set_consent(p_customer uuid, p_status text, p_note text default null) returns text
language plpgsql security definer set search_path = '' as $$
begin perform cx.require_staff(); return cx.set_consent(p_customer, p_status, 'staff', cx.staff_email(), cx.clean_text(p_note, 300)); end $$;

create or replace function public.staff_save_feedback(p_id bigint, p_customer uuid, p_kind text, p_body text, p_status text, p_resolution text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_id bigint := p_id; v_by text := cx.staff_email(); v_body text := cx.clean_text(p_body, 2000);
begin
  perform cx.require_staff();
  if v_body = '' then raise exception 'feedback text is required'; end if;
  if p_kind not in ('feedback','complaint','other') or p_status not in ('open','resolved') then raise exception 'invalid kind or status'; end if;
  if p_id is null then
    insert into public.customer_feedback(customer_id, kind, body, status, resolution, source, created_by, resolved_by, resolved_at)
    values (cx.root_of(p_customer), p_kind, v_body, p_status, nullif(cx.clean_text(p_resolution, 1000), ''), 'staff', v_by,
            case when p_status = 'resolved' then v_by end, case when p_status = 'resolved' then now() end) returning id into v_id;
  else
    update public.customer_feedback set kind = p_kind, body = v_body, status = p_status, resolution = nullif(cx.clean_text(p_resolution, 1000), ''),
      resolved_by = case when p_status = 'resolved' then coalesce(resolved_by, v_by) end, resolved_at = case when p_status = 'resolved' then coalesce(resolved_at, now()) end
    where id = p_id and removed_at is null;
  end if;
  return v_id;
end $$;

create or replace function public.staff_remove_feedback(p_id bigint) returns void language plpgsql security definer set search_path = '' as $$
begin perform cx.require_staff(); update public.customer_feedback set removed_at = now(), removed_by = cx.staff_email() where id = p_id; end $$;

create or replace function public.staff_add_note(p_customer uuid, p_note text) returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint; v text := cx.clean_text(p_note, 2000);
begin perform cx.require_staff(); if v = '' then raise exception 'note is empty'; end if;
  insert into public.customer_internal_notes(customer_id, note, created_by) values (cx.root_of(p_customer), v, cx.staff_email()) returning id into v_id; return v_id; end $$;

create or replace function public.staff_remove_note(p_id bigint) returns void language plpgsql security definer set search_path = '' as $$
begin perform cx.require_staff(); update public.customer_internal_notes set removed_at = now(), removed_by = cx.staff_email() where id = p_id; end $$;

create or replace function public.staff_save_contact(p_id bigint, p_customer uuid, p_contacted_at timestamptz, p_channel text, p_message text, p_offer text,
  p_staff_name text, p_response text, p_reason text, p_next_follow_up date) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_id bigint := p_id; v_by text := cx.staff_email();
begin
  perform cx.require_staff();
  if p_channel not in ('whatsapp','call','sms','in_person','email','other') then raise exception 'invalid channel'; end if;
  if p_id is null then
    insert into public.contact_log(customer_id, contacted_at, channel, message, offer, staff_name, customer_response, inactivity_reason, next_follow_up, created_by)
    values (cx.root_of(p_customer), coalesce(p_contacted_at, now()), p_channel, cx.clean_text(p_message, 2000), cx.clean_text(p_offer, 300),
            cx.clean_text(coalesce(nullif(p_staff_name,''), v_by), 80), cx.clean_text(p_response, 1000), cx.clean_text(p_reason, 500), p_next_follow_up, v_by) returning id into v_id;
  else
    update public.contact_log set contacted_at = coalesce(p_contacted_at, contacted_at), channel = p_channel, message = cx.clean_text(p_message, 2000), offer = cx.clean_text(p_offer, 300),
      staff_name = cx.clean_text(coalesce(nullif(p_staff_name,''), staff_name), 80), customer_response = cx.clean_text(p_response, 1000), inactivity_reason = cx.clean_text(p_reason, 500),
      next_follow_up = p_next_follow_up where id = p_id and removed_at is null;
  end if;
  return v_id;
end $$;

create or replace function public.staff_remove_contact(p_id bigint) returns void language plpgsql security definer set search_path = '' as $$
begin perform cx.require_staff(); update public.contact_log set removed_at = now(), removed_by = cx.staff_email() where id = p_id; end $$;

create or replace function public.staff_set_society(p_customer uuid, p_society text) returns void language plpgsql security definer set search_path = '' as $$
begin perform cx.require_staff(); update public.customer_identities set society = nullif(cx.clean_text(p_society, 80), '') where id = cx.root_of(p_customer); end $$;

create or replace function public.staff_create_form_link(p_customer uuid, p_days int default 90) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tok text; v_exp timestamptz := now() + make_interval(days => greatest(1, least(coalesce(p_days, 90), 365)));
begin
  perform cx.require_staff();
  v_tok := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.preference_form_tokens(customer_id, token_hash, kind, created_by, expires_at)
  values (cx.root_of(p_customer), encode(sha256(convert_to(v_tok, 'UTF8')), 'hex'), 'staff_link', cx.staff_email(), v_exp);
  return jsonb_build_object('token', v_tok, 'expires_at', v_exp);
end $$;

create or replace function public.staff_revoke_form_links(p_customer uuid) returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin perform cx.require_staff();
  update public.preference_form_tokens set revoked_at = now() where customer_id = any(cx.group_ids(cx.root_of(p_customer))) and revoked_at is null;
  get diagnostics n = row_count; return n; end $$;

create or replace function public.staff_duplicate_candidates() returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform cx.require_staff();
  return coalesce((select jsonb_agg(jsonb_build_object('a', d.a, 'b', d.b, 'reason', d.reason,
     'a_name', x.display_name, 'a_phone', x.phone_raw, 'a_tower', x.tower, 'a_flat', x.flat, 'a_orders', ax.delivered_orders, 'a_last', ax.last_delivered_date,
     'b_name', y.display_name, 'b_phone', y.phone_raw, 'b_tower', y.tower, 'b_flat', y.flat, 'b_orders', ay.delivered_orders, 'b_last', ay.last_delivered_date))
   from cx.duplicate_pairs() d join public.customer_identities x on x.id = d.a join public.customer_identities y on y.id = d.b
   left join public.customer_analysis ax on ax.customer_id = d.a left join public.customer_analysis ay on ay.customer_id = d.b), '[]'::jsonb); end $$;

create or replace function public.staff_dismiss_duplicate(p_a uuid, p_b uuid) returns void language plpgsql security definer set search_path = '' as $$
begin perform cx.require_staff();
  insert into public.duplicate_dismissals(a, b, dismissed_by) values (least(p_a, p_b), greatest(p_a, p_b), cx.staff_email()) on conflict do nothing; end $$;

create or replace function public.staff_merge_customers(p_from uuid, p_into uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare f record; t record; rec record; v_by text := cx.staff_email(); cf text; ct text; v_final text; v_review boolean := false;
  v_conf jsonb := '[]'::jsonb; v_cur jsonb; v_why text; v_orders int;
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

  select coalesce((select status from public.customer_consent_current where customer_id = p_from), 'unknown') into cf;
  select coalesce((select status from public.customer_consent_current where customer_id = p_into), 'unknown') into ct;
  if cf = 'opted_out' then v_final := 'opted_out'; v_review := (ct = 'opted_in');
  else v_final := ct; v_review := (cf = 'opted_in' and ct <> 'opted_in'); end if;
  if v_final <> ct then
    insert into public.marketing_consent_log(customer_id, status, source, captured_by, note)
    values (p_into, v_final, 'merge', v_by, format('Merge: %s record was opted_out; applied conservatively', f.phone_raw));
  end if;
  if f.consent_needs_review then v_review := true; end if;
  if v_review then
    v_why := format('Merged records had different consent (%s vs %s). Currently treated as %s; confirm with the customer.', cf, ct, v_final);
    update public.customer_identities set consent_needs_review = true, consent_review_reason = v_why where id = p_into;
  end if;

  update public.customer_identities set merged_into = p_into, merged_at = now(), merged_by = v_by, merge_reason = trim(p_reason) where id = p_from;
  select count(*) into v_orders from public.orders where phone = any(cx.group_phones(p_into));
  insert into public.customer_merge_audit(from_id, into_id, reason, merged_by, details)
  values (p_from, p_into, trim(p_reason), v_by, jsonb_build_object('from_phone', f.phone_raw, 'into_phone', t.phone_raw, 'from_name', f.display_name, 'into_name', t.display_name,
    'consent_from', cf, 'consent_into', ct, 'consent_final', v_final, 'consent_review', v_review, 'preference_conflicts', v_conf, 'orders_after_merge', v_orders));
  perform cx.refresh_customer(p_into);
  perform cx.refresh_customer(p_from);
  return jsonb_build_object('ok', true, 'into', p_into, 'consent_final', v_final, 'consent_review', v_review, 'preference_conflicts', v_conf);
end $$;

create or replace function public.staff_dish_catalog() returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform cx.require_staff();
  return coalesce((select jsonb_agg(jsonb_build_object('id', dc.id, 'name', dc.canonical_name, 'category', dc.category,
      'aliases', (select coalesce(jsonb_agg(a.original_label order by a.original_label), '[]') from public.dish_aliases a where a.dish_id = dc.id),
      'orders', (select count(distinct c.order_id) from public.order_snapshot_components c where c.dish_id = dc.id)) order by dc.category, dc.canonical_name)
    from public.dish_catalog dc where dc.merged_into is null), '[]'::jsonb); end $$;

create or replace function public.staff_update_dish(p_id uuid, p_name text, p_category text) returns void language plpgsql security definer set search_path = '' as $$
begin perform cx.require_staff();
  if p_category not in ('sabji','dal','rice','raita','sweet','salad','bread','other') then raise exception 'invalid category'; end if;
  update public.dish_catalog set canonical_name = coalesce(nullif(cx.clean_text(p_name, 80), ''), canonical_name), category = p_category where id = p_id and merged_into is null;
  perform cx.refresh_all('dish_updated');
end $$;

create or replace function public.staff_merge_dishes(p_from uuid, p_into uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform cx.require_staff();
  if p_from = p_into then raise exception 'choose two different dishes'; end if;
  if not exists (select 1 from public.dish_catalog where id = p_from and merged_into is null) or not exists (select 1 from public.dish_catalog where id = p_into and merged_into is null) then
    raise exception 'both dishes must exist and be active';
  end if;
  perform set_config('cx.allow_snapshot_edit', 'on', true);
  update public.order_snapshot_components set dish_id = p_into where dish_id = p_from;
  perform set_config('cx.allow_snapshot_edit', 'off', true);
  delete from public.menu_publication_dishes a using public.menu_publication_dishes b
    where a.dish_id = p_from and b.dish_id = p_into and a.publication_id = b.publication_id and a.role = b.role;
  update public.menu_publication_dishes set dish_id = p_into where dish_id = p_from;
  update public.dish_aliases set dish_id = p_into where dish_id = p_from;
  update public.dish_catalog set merged_into = p_into where id = p_from;
  return cx.refresh_all('dish_merged');
end $$;

create or replace function public.staff_correct_order_snapshot(p_order_id text, p_components jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c jsonb; v_old jsonb; v_by text := cx.staff_email(); v_unknown int := 0; v_phone text; v_id uuid; v_ok boolean; v_cat text; v_sel text;
begin
  perform cx.require_staff();
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'a reason is required for corrections'; end if;
  if p_components is null or jsonb_typeof(p_components) <> 'array' then raise exception 'components must be an array'; end if;
  if not exists (select 1 from public.order_snapshots where order_id = p_order_id) then raise exception 'snapshot not found'; end if;
  select coalesce(jsonb_agg(to_jsonb(x)), '[]') into v_old from (select line_index, role, category, label_original, selection, unit_qty, dish_id from public.order_snapshot_components where order_id = p_order_id order by id) x;
  perform set_config('cx.allow_snapshot_edit', 'on', true);
  delete from public.order_snapshot_components where order_id = p_order_id;
  for c in select * from jsonb_array_elements(p_components) loop
    v_cat := c->>'category'; v_sel := coalesce(c->>'selection', 'fixed');
    if coalesce(c->>'role','') not in ('main','side','bread') or v_sel not in ('fixed','chosen','unknown')
       or (v_cat is not null and v_cat not in ('sabji','dal','rice','raita','sweet','salad','bread','other')) then
      perform set_config('cx.allow_snapshot_edit', 'off', true);
      raise exception 'invalid component';
    end if;
    if v_sel = 'unknown' then v_unknown := v_unknown + 1; end if;
    insert into public.order_snapshot_components(order_id, line_index, role, category, dish_id, label_original, selection, unit_qty)
    values (p_order_id, coalesce((c->>'line_index')::int, 0), c->>'role', v_cat,
            case when v_sel = 'unknown' or v_cat is null or cx.clean_text(c->>'label', 80) = '' then null else cx.resolve_dish(cx.clean_text(c->>'label', 80), v_cat) end,
            nullif(cx.clean_text(c->>'label', 80), ''), v_sel, greatest(coalesce((c->>'unit_qty')::numeric, 1), 0));
  end loop;
  update public.order_snapshots set version = version + 1, needs_review = false, review_reason = null, corrected_at = now(), corrected_by = v_by,
    coverage = case when jsonb_array_length(p_components) = 0 then 'none' when v_unknown > 0 then 'partial' else 'full' end where order_id = p_order_id;
  update public.order_snapshot_lines set parsed = (v_unknown = 0) where order_id = p_order_id;
  perform set_config('cx.allow_snapshot_edit', 'off', true);
  insert into public.order_snapshot_audit(order_id, changed_by, reason, old_components, new_components) values (p_order_id, v_by, trim(p_reason), v_old, p_components);
  select phone into v_phone from public.orders where id = p_order_id;
  v_id := cx.ensure_identity(v_phone);
  return cx.refresh_customer(v_id);
end $$;

create or replace function public.staff_refresh_analysis(p_customer uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare res jsonb;
begin
  perform cx.require_staff();
  if p_customer is null then res := cx.refresh_all('manual_staff'); else res := cx.refresh_customer(cx.root_of(p_customer)); end if;
  return res || jsonb_build_object('errors_list', (select coalesce(jsonb_agg(row_to_json(e)), '[]') from (select id, customer_id, order_id, context, error, created_at from public.analysis_errors where resolved_at is null order by id desc limit 20) e));
end $$;

revoke all on all functions in schema cx from public, anon, authenticated;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'staff\_%' loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;