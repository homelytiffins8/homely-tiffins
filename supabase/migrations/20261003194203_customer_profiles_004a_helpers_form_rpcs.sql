create or replace function cx.staff_email() returns text language sql stable set search_path = '' as $$
  select coalesce(nullif((select auth.jwt()) ->> 'email', ''), 'staff') $$;

create or replace function cx.require_staff() returns void language plpgsql stable set search_path = '' as $$
begin if not public.is_staff() then raise exception 'not authorised' using errcode = '42501'; end if; end $$;

create or replace function cx.canon_dish(p uuid) returns uuid language plpgsql stable set search_path = '' as $$
declare v uuid := p; m uuid; i int := 0;
begin
  loop
    select merged_into into m from public.dish_catalog where id = v;
    exit when m is null or i > 20;
    v := m; i := i + 1;
  end loop;
  return v;
end $$;

create or replace function cx.clean_text(p text, p_len int) returns text language sql immutable set search_path = '' as $$
  select left(regexp_replace(trim(coalesce(p,'')), '[[:cntrl:]]+', ' ', 'g'), p_len) $$;

create or replace function cx.norm_dish_list(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare e jsonb; lbl text; did uuid; v_out jsonb := '[]'::jsonb; seen text[] := '{}'; k text;
begin
  if p is null or jsonb_typeof(p) <> 'array' then return '[]'::jsonb; end if;
  for e in select * from jsonb_array_elements(p) loop
    lbl := cx.clean_text(case when jsonb_typeof(e) = 'string' then e #>> '{}' else e->>'label' end, 60);
    continue when lbl = '';
    k := cx.dish_key(lbl);
    continue when k = '' or k = any(seen);
    seen := seen || k;
    did := null;
    if jsonb_typeof(e) = 'object' and coalesce(e->>'dish_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      did := cx.canon_dish((e->>'dish_id')::uuid);
    else
      select cx.canon_dish(dish_id) into did from public.dish_aliases where alias_key = k;
    end if;
    if did is not null then select canonical_name into lbl from public.dish_catalog where id = did; end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('label', lbl, 'dish_id', did));
    exit when jsonb_array_length(v_out) >= 20;
  end loop;
  return v_out;
end $$;

create or replace function cx.set_pref(p_customer uuid, p_field text, p_value jsonb, p_source text, p_by text, p_note text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare v_root uuid := cx.root_of(p_customer); v jsonb; cur jsonb; txt text;
begin
  if p_field in ('fav_dishes','fav_sides','disliked_dishes') then
    v := cx.norm_dish_list(p_value);
    if jsonb_array_length(v) = 0 then v := null; end if;
  elsif p_field in ('spice','oil','bread_pref','portion_pref','usual_meal') then
    txt := lower(cx.clean_text(p_value #>> '{}', 30));
    if txt = '' then v := null;
    else
      if not ((p_field = 'spice' and txt in ('mild','medium','spicy'))
           or (p_field = 'oil' and txt in ('less_oil','regular'))
           or (p_field = 'bread_pref' and txt in ('roti','paratha','rice','no_preference'))
           or (p_field = 'portion_pref' and txt in ('smaller','regular','larger'))
           or (p_field = 'usual_meal' and txt in ('lunch','dinner','both'))) then
        raise exception 'invalid value for %', p_field;
      end if;
      v := to_jsonb(txt);
    end if;
  elsif p_field = 'reason_stopped' then
    txt := cx.clean_text(p_value #>> '{}', 300);
    v := case when txt = '' then null else to_jsonb(txt) end;
  elsif p_field in ('away_until','follow_up_date') then
    txt := trim(coalesce(p_value #>> '{}', ''));
    if txt = '' then v := null;
    elsif txt !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'invalid date';
    else perform txt::date; v := to_jsonb(txt); end if;
  else raise exception 'unknown field %', p_field;
  end if;

  select value into cur from public.customer_prefs_current where customer_id = v_root and field = p_field;
  if v is null then
    if cur is null then return 'unchanged'; end if;
    insert into public.customer_pref_log(customer_id, field, action, value, source, set_by, note)
    values (v_root, p_field, 'remove', null, p_source, p_by, p_note);
    return 'removed';
  end if;
  if cur is not distinct from v then return 'unchanged'; end if;
  insert into public.customer_pref_log(customer_id, field, action, value, source, set_by, note)
  values (v_root, p_field, 'set', v, p_source, p_by, p_note);
  return 'set';
end $$;

create or replace function cx.set_consent(p_customer uuid, p_status text, p_source text, p_by text, p_note text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare v_root uuid := cx.root_of(p_customer); cur text;
begin
  if p_status not in ('unknown','opted_in','opted_out') then raise exception 'invalid consent status'; end if;
  select status into cur from public.customer_consent_current where customer_id = v_root;
  if p_source = 'staff' then
    update public.customer_identities set consent_needs_review = false, consent_review_reason = null where id = v_root;
  end if;
  if coalesce(cur, 'unknown') = p_status and cur is not null then return 'unchanged'; end if;
  if cur is null and p_status = 'unknown' then
    insert into public.marketing_consent_log(customer_id, status, source, captured_by, note) values (v_root, p_status, p_source, p_by, p_note);
    return 'set';
  end if;
  insert into public.marketing_consent_log(customer_id, status, source, captured_by, note) values (v_root, p_status, p_source, p_by, p_note);
  return 'set';
end $$;

-- suggested next action. Pure function over a jsonb of already-computed facts.
create or replace function cx.suggest(p jsonb) returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_days int := nullif(p->>'days_since','')::int; v_bucket text := p->>'bucket';
  n int := coalesce((p->>'delivered_orders')::int, 0);
  v_consent text := coalesce(p->>'consent', 'unknown');
  v_away date := nullif(p->>'away_until','')::date; v_fu date := nullif(p->>'follow_up','')::date;
  v_lastc date := nullif(p->>'last_contact_date','')::date; v_lastch text := p->>'last_contact_channel';
  v_compl int := coalesce((p->>'complaints')::int, 0);
  v_today date := (p->>'today')::date; v_sup int := coalesce((p->>'suppress_days')::int, 7);
  v_conf text := nullif(p->>'confirmed_match',''); v_mdl text := nullif(p->>'delivered_match',''); v_mdate text := nullif(p->>'menu_date','');
  v_regular boolean := n >= 4;
  v_note text := case when v_consent = 'unknown' then ' Marketing consent unknown: review before sending any promotional message.' else '' end;
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
  if v_consent = 'opted_out' then
    return jsonb_build_object('action','no_promo','label','Do not send promotions','reason','Opted out of WhatsApp promotions. Contact only if they reach out.','priority',85);
  end if;
  if v_bucket = 'inactive_7_13' then
    if v_conf is not null and v_mdate is not null then
      return jsonb_build_object('action','menu_reminder','label','Send a personal menu reminder',
        'reason', format('Confirmed favourite %s, %s days inactive, and %s is on the published menu for %s.', v_conf, v_days, v_conf, v_mdate) || v_note,
        'priority', 10, 'draft','reminder', 'dish', v_conf, 'dish_basis','confirmed', 'menu_date', v_mdate);
    elsif v_mdl is not null and v_mdate is not null then
      return jsonb_build_object('action','menu_reminder','label','Send a menu reminder',
        'reason', format('Most delivered dish is %s (not a confirmed favourite); %s days inactive; it is on the published menu for %s.', v_mdl, v_days, v_mdate) || v_note,
        'priority', 20, 'draft','reminder', 'dish', v_mdl, 'dish_basis','most_delivered', 'menu_date', v_mdate);
    else
      return jsonb_build_object('action','gentle_reminder','label','Send a gentle reminder',
        'reason', format('%s days since the last delivery. No confirmed or most-delivered dish appears on a published menu%s.', v_days,
           case when v_mdate is null then ' (no menu is published for today or later)' else '' end) || v_note,
        'priority', 30, 'draft','reminder');
    end if;
  end if;
  return jsonb_build_object('action','checkin','label','Personal check-in',
    'reason', format('%s days inactive%s. Ask for feedback before suggesting any offer.', v_days,
       case when v_regular then ', previously regular (' || n || ' delivered orders)' else '' end) || v_note,
    'priority', case when v_regular then 5 else 40 end, 'draft','checkin');
end $$;

-- ───────────── customer-facing preference form (no accounts exist, so access is by an unguessable, revocable token)
create or replace function public.pref_form_token_for_order(p_order_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o record; v_id uuid; v_tok text; v_root uuid;
begin
  select id, phone, created_at into o from public.orders where id = p_order_id;
  if not found or o.created_at < now() - interval '30 days' then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  v_id := cx.ensure_identity(o.phone);
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  v_root := cx.root_of(v_id);
  -- keep at most 5 live order-links per customer
  update public.preference_form_tokens set revoked_at = now()
  where id in (select id from public.preference_form_tokens where customer_id = v_root and kind = 'order_link' and revoked_at is null and expires_at > now()
               order by id desc offset 4);
  v_tok := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.preference_form_tokens(customer_id, token_hash, kind, created_by, expires_at)
  values (v_root, encode(sha256(convert_to(v_tok, 'UTF8')), 'hex'), 'order_link', 'customer_order', now() + interval '30 days');
  return jsonb_build_object('ok', true, 'token', v_tok);
end $$;

create or replace function cx.form_token(p_token text) returns public.preference_form_tokens
language plpgsql security definer set search_path = '' as $$
declare t public.preference_form_tokens;
begin
  if p_token is null or length(p_token) < 40 or length(p_token) > 100 then return null; end if;
  select * into t from public.preference_form_tokens
  where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') and revoked_at is null and expires_at > now();
  if t.id is null then return null; end if;
  update public.preference_form_tokens set last_used_at = now() where id = t.id;
  return t;
end $$;

create or replace function public.pref_form_get(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.preference_form_tokens; v_root uuid; v_name text; prefs jsonb; v_cons text; v_main jsonb; v_side jsonb; v_obs jsonb;
begin
  t := cx.form_token(p_token);
  if t.id is null then return jsonb_build_object('ok', false, 'error', 'invalid_or_expired'); end if;
  v_root := cx.root_of(t.customer_id);
  select split_part(trim(coalesce(display_name,'')), ' ', 1) into v_name from public.customer_identities where id = v_root;
  select coalesce(jsonb_object_agg(field, value), '{}') into prefs from public.customer_prefs_current
    where customer_id = v_root and field in ('fav_dishes','fav_sides','disliked_dishes','spice','oil','bread_pref','portion_pref','usual_meal');
  select status into v_cons from public.customer_consent_current where customer_id = v_root;
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
  return jsonb_build_object('ok', true, 'first_name', nullif(v_name,''), 'answers', prefs, 'whatsapp', coalesce(v_cons, 'unknown'),
    'main_options', v_main, 'side_options', v_side, 'observed', v_obs);
end $$;

create or replace function public.pref_form_save(p_token text, p_answers jsonb, p_whatsapp text default null) returns jsonb
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
  if p_whatsapp in ('opt_in','opt_out') then
    perform cx.set_consent(v_root, case p_whatsapp when 'opt_in' then 'opted_in' else 'opted_out' end, v_src, 'customer',
      case p_whatsapp when 'opt_in' then 'Ticked the WhatsApp offers box on the preference form' else 'Opted out on the preference form' end);
  end if;
  insert into public.preference_form_submissions(customer_id, token_id, token_kind, skipped, answers)
  values (v_root, t.id, t.kind, false, p_answers - 'feedback');
  return jsonb_build_object('ok', true, 'changed', v_changed);
end $$;

create or replace function public.pref_form_skip(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.preference_form_tokens;
begin
  t := cx.form_token(p_token);
  if t.id is null then return jsonb_build_object('ok', false, 'error', 'invalid_or_expired'); end if;
  insert into public.preference_form_submissions(customer_id, token_id, token_kind, skipped) values (cx.root_of(t.customer_id), t.id, t.kind, true);
  return jsonb_build_object('ok', true);
end $$;

revoke all on all functions in schema cx from public, anon, authenticated;
revoke execute on function public.pref_form_token_for_order(text), public.pref_form_get(text), public.pref_form_save(text, jsonb, text), public.pref_form_skip(text) from public;
grant execute on function public.pref_form_token_for_order(text), public.pref_form_get(text), public.pref_form_save(text, jsonb, text), public.pref_form_skip(text) to anon, authenticated;