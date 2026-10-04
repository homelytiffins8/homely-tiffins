-- 007: fix "canceling statement due to statement timeout" on Customers > report and customer list.
-- Cause: cx.customer_summary() ran cx.duplicate_pairs() (~35 ms, self-join) once per customer,
-- i.e. 177 x 35 ms = ~6 s, against the 8 s statement_timeout of the `authenticated` role.
-- Fix: compute the set of possibly-duplicate customer ids once per transaction (= once per RPC call).

create or replace function cx.dup_ids_cached() returns uuid[]
language plpgsql volatile security definer set search_path = '' as $$
declare v text; r uuid[];
begin
  v := current_setting('cx.dup_ids', true);
  if v is not null and v <> '' then return v::uuid[]; end if;
  select coalesce(array_agg(distinct u), '{}'::uuid[]) into r
    from (select p.a u from cx.duplicate_pairs() p union all select p.b from cx.duplicate_pairs() p) s;
  perform set_config('cx.dup_ids', r::text, true);   -- transaction-local
  return r;
end $$;

create or replace function cx.customer_summary(p_root uuid, p_today date, p_menu jsonb, p_sup integer)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
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
  v_dup := p_root = any(cx.dup_ids_cached());   -- was: exists (select 1 from cx.duplicate_pairs() ...) per customer

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
end $function$;
