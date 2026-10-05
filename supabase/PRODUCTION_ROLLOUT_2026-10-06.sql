-- ════════════════════════════════════════════════════════════════════
-- HOMELY TIFFINS — PRODUCTION DATABASE ROLLOUT (6 Oct 2026)
-- Run ONCE in the Supabase SQL Editor of the PRODUCTION project
--   (homelytiffins8's Project, id locesmksvetbdhsvgqip) — NOT staging.
-- Exactly the same database changes that are live on staging:
--   customer profiles / insights / reactivation (001–007), delete + archive
--   inactive customers (008), menu-photos storage bucket, full server-side
--   order validation (kitchen closed, plans/extras on-off, menu, qty…).
-- All-or-nothing: wrapped in one transaction, so if anything fails nothing
-- is changed. Orders, customers and credit data are not modified.
-- ════════════════════════════════════════════════════════════════════
begin;

-- ─────────── 20261003193558_customer_profiles_001_schema.sql ───────────
create schema if not exists cx;
revoke all on schema cx from public, anon, authenticated;

create or replace function public.is_staff() returns boolean
language sql stable set search_path = ''
as $$
  select coalesce((select auth.role()), '') = 'authenticated'
     and coalesce((((select auth.jwt()) ->> 'is_anonymous'))::boolean, false) = false
$$;
revoke execute on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated;

create table public.cx_config (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
insert into public.cx_config(key, value) values
  ('slot_cutoff_hour_ist', '16'::jsonb),
  ('recent_contact_suppress_days', '7'::jsonb),
  ('default_society', 'null'::jsonb);

create table public.variant_map (
  variant text primary key, label text not null, tier int not null, is_meal boolean not null default true, notes text
);
insert into public.variant_map(variant,label,tier,is_meal,notes) values
  ('mini',        'Homely Mini',        1, true,  'Entry tier'),
  ('standard',    'Homely Standard',    2, true,  ''),
  ('goldMini',    'Homely Gold Mini',   3, true,  ''),
  ('goldMedium',  'Homely Gold (Medium)',4, true, ''),
  ('goldLarge',   'Homely Gold (Large)',5, true,  ''),
  ('extra',       'Extras / à-la-carte',0, false, 'Not a meal tier; excluded from upgrade/downgrade');

create table public.customer_identities (
  id uuid primary key default gen_random_uuid(),
  phone_raw text not null unique,
  phone_norm text,
  display_name text, tower text, flat text, society text,
  merged_into uuid references public.customer_identities(id),
  merged_at timestamptz, merged_by text, merge_reason text,
  consent_needs_review boolean not null default false,
  consent_review_reason text,
  created_at timestamptz not null default now(),
  constraint ci_not_self check (merged_into is null or merged_into <> id)
);
create index ci_phone_norm_idx on public.customer_identities(phone_norm);
create index ci_merged_idx on public.customer_identities(merged_into);

create table public.duplicate_dismissals (
  a uuid not null, b uuid not null, dismissed_by text, dismissed_at timestamptz not null default now(),
  primary key (a, b), check (a < b)
);

create table public.customer_merge_audit (
  id bigserial primary key, from_id uuid not null, into_id uuid not null, reason text,
  merged_by text, merged_at timestamptz not null default now(), details jsonb
);

create table public.dish_catalog (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  category text not null check (category in ('sabji','dal','rice','raita','sweet','salad','bread','other')),
  merged_into uuid references public.dish_catalog(id),
  created_at timestamptz not null default now()
);
create table public.dish_aliases (
  alias_key text primary key,
  dish_id uuid not null references public.dish_catalog(id) on delete cascade,
  original_label text, first_seen timestamptz not null default now()
);
create index dish_aliases_dish_idx on public.dish_aliases(dish_id);

create table public.menu_publications (
  id bigserial primary key,
  service_date date not null,
  published_at timestamptz not null default now(),
  source text not null default 'trigger',
  content_hash text not null,
  raw jsonb not null,
  unique (service_date, content_hash)
);
create table public.menu_publication_dishes (
  publication_id bigint not null references public.menu_publications(id) on delete cascade,
  dish_id uuid not null references public.dish_catalog(id),
  role text not null check (role in ('sabji','rice','raita','sweet','salad')),
  premium boolean not null default false,
  primary key (publication_id, dish_id, role)
);

create table public.order_snapshots (
  order_id text primary key references public.orders(id) on delete cascade,
  service_date date,
  source text not null check (source in ('captured_at_order','backfill_from_order_items')),
  coverage text not null check (coverage in ('full','partial','none')),
  parser_version text not null,
  raw_items jsonb not null,
  menu_publication_id bigint references public.menu_publications(id),
  version int not null default 1,
  needs_review boolean not null default false,
  review_reason text,
  created_at timestamptz not null default now(),
  corrected_at timestamptz, corrected_by text
);
create table public.order_snapshot_lines (
  order_id text not null references public.orders(id) on delete cascade,
  line_index int not null,
  item_id text, item_name text, qty numeric not null default 1,
  variant text not null, size text, parsed boolean not null default false,
  primary key (order_id, line_index)
);
create table public.order_snapshot_components (
  id bigserial primary key,
  order_id text not null references public.orders(id) on delete cascade,
  line_index int not null,
  role text not null check (role in ('main','side','bread')),
  category text, dish_id uuid references public.dish_catalog(id),
  label_original text,
  selection text not null check (selection in ('fixed','chosen','unknown')),
  unit_qty numeric not null default 1
);
create index osc_order_idx on public.order_snapshot_components(order_id);
create index osc_dish_idx on public.order_snapshot_components(dish_id);
create table public.order_snapshot_audit (
  id bigserial primary key, order_id text not null, changed_at timestamptz not null default now(),
  changed_by text, reason text not null, old_components jsonb, new_components jsonb
);

create table public.customer_analysis (
  customer_id uuid primary key references public.customer_identities(id) on delete cascade,
  as_of_date date not null,
  refreshed_at timestamptz not null default now(),
  first_delivered_date date, last_delivered_date date,
  delivered_orders int not null default 0,
  gross_amount numeric not null default 0, discount_amount numeric not null default 0,
  net_spend numeric not null default 0, avg_order_value numeric,
  usual_variant text, variant_counts jsonb not null default '{}',
  usual_size text, size_counts jsonb not null default '{}',
  slot_counts jsonb not null default '{}', weekday_counts jsonb not null default '{}',
  median_gap_days numeric, orders_per_week numeric,
  windows jsonb not null default '{}',
  variant_shift text,
  coverage jsonb not null default '{}'
);
create table public.customer_dish_stats (
  customer_id uuid not null references public.customer_identities(id) on delete cascade,
  dish_id uuid not null references public.dish_catalog(id),
  win text not null check (win in ('lifetime','d30','d90','prev30')),
  role_group text not null check (role_group in ('main','side','bread')),
  category text,
  delivered_orders int not null, explicit_orders int not null, fixed_orders int not null,
  qty numeric not null, first_date date, last_date date, last_explicit_date date,
  eligible_orders int, selected_of_eligible int,
  primary key (customer_id, dish_id, win)
);
create table public.analysis_errors (
  id bigserial primary key, customer_id uuid, order_id text, context text, error text,
  created_at timestamptz not null default now(), resolved_at timestamptz
);
create table public.analysis_runs (
  id bigserial primary key, started_at timestamptz not null default now(), finished_at timestamptz,
  trigger text, customers_refreshed int default 0, errors int default 0
);

create table public.customer_pref_log (
  id bigserial primary key,
  customer_id uuid not null references public.customer_identities(id) on delete cascade,
  field text not null check (field in ('fav_dishes','fav_sides','disliked_dishes','spice','oil','bread_pref','portion_pref','usual_meal','reason_stopped','away_until','follow_up_date')),
  action text not null check (action in ('set','remove')),
  value jsonb,
  source text not null check (source in ('staff','customer_form_staff_link','customer_form_order_link','merge')),
  set_by text, set_at timestamptz not null default now(), note text
);
create index cpl_cust_idx on public.customer_pref_log(customer_id, field, id desc);

create table public.customer_feedback (
  id bigserial primary key,
  customer_id uuid not null references public.customer_identities(id) on delete cascade,
  kind text not null check (kind in ('feedback','complaint','other')),
  body text not null,
  status text not null default 'open' check (status in ('open','resolved')),
  resolution text,
  source text not null check (source in ('staff','customer_form_staff_link','customer_form_order_link')),
  created_by text, created_at timestamptz not null default now(),
  resolved_by text, resolved_at timestamptz,
  removed_at timestamptz, removed_by text
);
create table public.customer_internal_notes (
  id bigserial primary key,
  customer_id uuid not null references public.customer_identities(id) on delete cascade,
  note text not null, created_by text, created_at timestamptz not null default now(),
  removed_at timestamptz, removed_by text
);
create table public.marketing_consent_log (
  id bigserial primary key,
  customer_id uuid not null references public.customer_identities(id) on delete cascade,
  status text not null check (status in ('unknown','opted_in','opted_out')),
  source text not null check (source in ('staff','customer_form_staff_link','customer_form_order_link','merge')),
  captured_by text, captured_at timestamptz not null default now(), note text
);
create index mcl_cust_idx on public.marketing_consent_log(customer_id, id desc);

create table public.contact_log (
  id bigserial primary key,
  customer_id uuid not null references public.customer_identities(id) on delete cascade,
  contacted_at timestamptz not null default now(),
  channel text not null check (channel in ('whatsapp','call','sms','in_person','email','other')),
  message text, offer text, staff_name text, customer_response text, inactivity_reason text,
  next_follow_up date,
  created_by text, created_at timestamptz not null default now(),
  removed_at timestamptz, removed_by text
);
create index cl_cust_idx on public.contact_log(customer_id, contacted_at desc);

create table public.preference_form_tokens (
  id bigserial primary key,
  customer_id uuid not null references public.customer_identities(id) on delete cascade,
  token_hash text not null unique,
  kind text not null check (kind in ('staff_link','order_link')),
  created_by text, created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz, last_used_at timestamptz
);
create table public.preference_form_submissions (
  id bigserial primary key,
  customer_id uuid not null references public.customer_identities(id) on delete cascade,
  token_id bigint references public.preference_form_tokens(id),
  token_kind text, submitted_at timestamptz not null default now(),
  skipped boolean not null default false, answers jsonb
);

create view public.customer_prefs_current with (security_invoker = true) as
  select * from (
    select distinct on (customer_id, field) customer_id, field, action, value, source, set_by, set_at, note
    from public.customer_pref_log order by customer_id, field, id desc
  ) t where action = 'set';

create view public.customer_consent_current with (security_invoker = true) as
  select distinct on (customer_id) customer_id, status, source, captured_by, captured_at, note
  from public.marketing_consent_log order by customer_id, id desc;

do $$
declare t text;
begin
  foreach t in array array['cx_config','variant_map','customer_identities','duplicate_dismissals','customer_merge_audit',
    'dish_catalog','dish_aliases','menu_publications','menu_publication_dishes','order_snapshots','order_snapshot_lines',
    'order_snapshot_components','order_snapshot_audit','customer_analysis','customer_dish_stats','analysis_errors',
    'analysis_runs','customer_pref_log','customer_feedback','customer_internal_notes','marketing_consent_log',
    'contact_log','preference_form_tokens','preference_form_submissions']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    if t <> 'preference_form_tokens' then
      execute format('grant select on public.%I to authenticated', t);
      execute format('create policy %I on public.%I for select to authenticated using ((select public.is_staff()))', t || '_staff_read', t);
    end if;
  end loop;
end $$;
grant select on public.customer_prefs_current, public.customer_consent_current to authenticated;
revoke all on public.customer_prefs_current, public.customer_consent_current from anon;

-- ─────────── 20261003193808_customer_profiles_002_engine.sql ───────────
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

-- ─────────── 20261003193852_customer_profiles_002b_fix_refresh.sql ───────────
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

-- ─────────── 20261003193947_customer_profiles_003_triggers_cron.sql ───────────
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

-- ─────────── 20261003194203_customer_profiles_004a_helpers_form_rpcs.sql ───────────
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

-- ─────────── 20261003194424_customer_profiles_004b_staff_rpcs.sql ───────────
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

-- ─────────── 20261003194611_customer_profiles_004c_report_rpc.sql ───────────
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

-- ─────────── 20261003194704_customer_profiles_004d_report_rpc_fix.sql ───────────
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
     'last_delivered', c->>'last_delivered', 'delivered_orders', c->'delivered_orders', 'net_spend', c->'net_spend', 'consent', c->>'consent', 'suggestion', c->'suggestion')
     order by (c->>'net_spend')::numeric desc), '[]') into v_l713 from jsonb_array_elements(v_rows) c where c->>'bucket' = 'inactive_7_13';
  select coalesce(jsonb_agg(jsonb_build_object('id', c->>'id', 'name', c->>'name', 'phone', c->>'phone', 'tower', c->>'tower', 'flat', c->>'flat', 'days_since', c->'days_since',
     'last_delivered', c->>'last_delivered', 'delivered_orders', c->'delivered_orders', 'net_spend', c->'net_spend', 'consent', c->>'consent', 'suggestion', c->'suggestion')
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
    'customers_consent_unknown', (select count(*) from jsonb_array_elements(v_rows) c where c->>'consent' = 'unknown' and (c->>'delivered_orders')::int > 0),
    'customers_consent_needs_review', (select count(*) from jsonb_array_elements(v_rows) c where (c->>'consent_needs_review')::boolean),
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
    where c->>'bucket' = 'inactive_14_plus' and (c->>'delivered_orders')::int >= 3 and c->>'consent' <> 'opted_out';
  if v_cnt > 0 then
    select coalesce(jsonb_agg(txt), '[]') into v_ev from (select format('%s (%s): %s delivered orders, ₹%s spent, %s days inactive', c->>'name', coalesce(c->>'tower', 'tower unknown'), c->>'delivered_orders', c->>'net_spend', c->>'days_since') txt
      from jsonb_array_elements(v_rows) c where c->>'bucket' = 'inactive_14_plus' and (c->>'delivered_orders')::int >= 3 and c->>'consent' <> 'opted_out' order by (c->>'net_spend')::numeric desc limit 5) q;
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

-- ─────────── 20261003195952_customer_profiles_005_token_table_deny_policy.sql ───────────
create policy preference_form_tokens_no_direct_access on public.preference_form_tokens for all to anon, authenticated using (false) with check (false);

-- ─────────── 20261003221329_pref_form_status_for_order.sql ───────────
-- Lets the customer app ask (by order id) whether that customer has already saved the food-preferences form.
create or replace function public.pref_form_status_for_order(p_order_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare o record; v_id uuid; v_root uuid; v_done boolean := false;
begin
  select id, phone, created_at into o from public.orders where id = p_order_id;
  if not found or o.created_at < now() - interval '30 days' then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  select id into v_id from public.customer_identities where phone_raw = o.phone;
  if v_id is null then
    return jsonb_build_object('ok', true, 'completed', false);
  end if;
  v_root := cx.root_of(v_id);
  select exists (
    select 1 from public.preference_form_submissions s
    where s.customer_id in (v_id, v_root) and s.skipped = false
  ) into v_done;
  return jsonb_build_object('ok', true, 'completed', v_done);
end $function$;

revoke all on function public.pref_form_status_for_order(text) from public;
grant execute on function public.pref_form_status_for_order(text) to anon, authenticated, service_role;

-- ─────────── 20261004000000_customer_profiles_006_remove_consent.sql ───────────
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

-- ─────────── 20261004120000_customer_profiles_007_report_timeout_fix.sql ───────────
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

-- ─────────── 20261006000000_customer_profiles_008_delete_inactive.sql ───────────
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

-- ─────────── 20261006120000_menu_photos_storage_bucket.sql ───────────
-- Menu photos move out of app_data (base64 inside ht_plan_config) into a public Storage bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu-photos', 'menu-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Public bucket: anyone can view a photo via its public URL.
-- Only the signed-in owner/staff (non-anonymous auth user) can upload or delete.
create policy "menu_photos_staff_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'menu-photos' and (select public.is_staff()));
create policy "menu_photos_staff_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'menu-photos' and (select public.is_staff()));

-- ─────────── 20261006140000_place_order_full_validation.sql ───────────
-- place_order: enforce every ordering rule on the server (the customer's screen can be stale or tampered with).
-- Errors raised (the app maps them to customer-facing messages):
--   KITCHEN_CLOSED, PLANS_NOT_AVAILABLE, ITEM_UNAVAILABLE: <reason>, INVALID_ORDER: <reason>
create or replace function public.place_order(p_order jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_plan_config      jsonb;
  v_menu             jsonb;
  v_promo_codes      jsonb;
  v_referral_config  jsonb;
  v_prices           jsonb;
  v_enabled          jsonb;
  v_sabjis           jsonb;
  v_sabji_ids        text[];
  v_nonprem_ids      text[];
  v_plans_ok         boolean;
  v_item             jsonb;
  v_item_id          text;
  v_parts            text[];
  v_sel              text[];
  v_qty_txt          text;
  v_qty              numeric;
  v_unit_price       numeric;
  v_menu_item        jsonb;
  v_computed_total   numeric := 0;
  v_item_count       int := 0;
  v_code             text;
  v_code_upper       text;
  v_promo            jsonb;
  v_discount         numeric := 0;
  v_kind             text := 'none';
  v_promo_code_out   text := null;
  v_promo_label_out  text := null;
  v_referral_code_out text := null;
  v_referrer_phone   text := null;
  v_referrer_name    text := null;
  v_phone            text;
  v_name             text;
  v_tower            text;
  v_flat             text;
  v_date             text := to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD');
  v_existing_orders  int;
  v_final_total      numeric;
  v_min_order        numeric;
  v_inserted_id      text;
begin
  -- 1. Kitchen must be open.
  if coalesce((select value #>> '{}' from public.app_data where key = 'ht_kitchen_open'), 'true') = 'false' then
    raise exception 'KITCHEN_CLOSED' using hint = 'The kitchen is closed and not accepting orders right now.';
  end if;

  -- 2. Customer details (same rules as the order form).
  v_phone := trim(coalesce(p_order->>'phone', ''));
  v_name  := trim(coalesce(p_order->>'customerName', ''));
  v_tower := trim(coalesce(p_order->>'tower', ''));
  v_flat  := trim(coalesce(p_order->>'flat', ''));
  if v_phone !~ '^\d{10}$' then raise exception 'INVALID_ORDER: enter a valid 10-digit phone number'; end if;
  if v_name = '' or length(v_name) > 80 then raise exception 'INVALID_ORDER: name is required'; end if;
  if v_tower = '' or length(v_tower) > 20 then raise exception 'INVALID_ORDER: tower is required'; end if;
  if v_flat = '' or length(v_flat) > 20 then raise exception 'INVALID_ORDER: flat is required'; end if;
  if coalesce(p_order->>'id', '') = '' or length(p_order->>'id') > 64 then raise exception 'INVALID_ORDER: missing order id'; end if;
  if jsonb_typeof(coalesce(p_order->'items', 'null'::jsonb)) <> 'array' or jsonb_array_length(p_order->'items') = 0 then
    raise exception 'INVALID_ORDER: cart is empty';
  end if;
  if jsonb_array_length(p_order->'items') > 30 then raise exception 'INVALID_ORDER: too many items'; end if;

  select value into v_plan_config     from public.app_data where key = 'ht_plan_config';
  select value into v_menu            from public.app_data where key = 'ht_menu';
  select value into v_promo_codes     from public.app_data where key = 'ht_promo_codes';
  select value into v_referral_config from public.app_data where key = 'ht_referral_config';

  v_prices  := coalesce(v_plan_config->'prices', '{}'::jsonb);
  v_enabled := coalesce(v_plan_config->'enabled', '{}'::jsonb);
  v_sabjis  := coalesce(v_plan_config->'sabjis', '[]'::jsonb);
  select coalesce(array_agg(s->>'id'), '{}') into v_sabji_ids from jsonb_array_elements(v_sabjis) s where coalesce(trim(s->>'name'), '') <> '';
  select coalesce(array_agg(id), '{}') into v_nonprem_ids from (
    select s->>'id' id from jsonb_array_elements(v_sabjis) with ordinality t(s, n)
    where not coalesce((s->>'premium')::boolean, false) and coalesce(trim(s->>'name'), '') <> '' order by n limit 2) x;
  -- Plans are orderable only when today's plan menu is published and complete (same rule as the app).
  v_plans_ok := v_plan_config is not null and v_plan_config->>'date' = v_date
    and coalesce(array_length(v_sabji_ids, 1), 0) = 3
    and coalesce(trim(v_plan_config->>'rice'), '') <> '' and coalesce(trim(v_plan_config->>'salad'), '') <> ''
    and coalesce(trim(v_plan_config->>'raita'), '') <> '' and coalesce(trim(v_plan_config->>'sweet'), '') <> '';

  -- 3. Validate + price every line from canonical data. item.price from the client is never trusted.
  for v_item in select * from jsonb_array_elements(p_order->'items')
  loop
    v_item_id := coalesce(v_item->>'id', '');
    v_qty_txt := coalesce(v_item->>'qty', '1');
    if v_qty_txt !~ '^\d+$' then raise exception 'INVALID_ORDER: invalid quantity'; end if;
    v_qty := v_qty_txt::numeric;
    if v_qty < 1 or v_qty > 50 then raise exception 'INVALID_ORDER: quantity must be between 1 and 50'; end if;
    v_parts := string_to_array(v_item_id, ':');
    v_unit_price := null;

    if v_parts[1] in ('gold', 'goldmini', 'plan-standard', 'mini', 'extra-raita', 'extra-salad', 'extra-sweet') and not v_plans_ok then
      raise exception 'PLANS_NOT_AVAILABLE' using hint = 'Today''s plans are not available right now.';
    end if;

    if v_parts[1] = 'gold' then
      -- gold:<medium|large>:<bread>:<sabji+sabji>:<raita|sweet>
      if coalesce(array_length(v_parts, 1), 0) <> 5 or v_parts[2] not in ('medium', 'large')
         or v_parts[3] not in ('chapati4', 'paratha3') or v_parts[5] not in ('raita', 'sweet') then
        raise exception 'INVALID_ORDER: invalid Homely Gold choice';
      end if;
      if not coalesce((v_enabled->>(case v_parts[2] when 'large' then 'goldLarge' else 'goldMedium' end))::boolean, true) then
        raise exception 'ITEM_UNAVAILABLE: Homely Gold (%) is not available today', initcap(v_parts[2]);
      end if;
      v_sel := string_to_array(v_parts[4], '+');
      if coalesce(array_length(v_sel, 1), 0) <> 2 or v_sel[1] = v_sel[2] or not (v_sel <@ v_sabji_ids) then
        raise exception 'ITEM_UNAVAILABLE: chosen sabjis are not on today''s menu';
      end if;
      v_unit_price := coalesce((v_prices->>'gold')::numeric, 0)
        + case when v_parts[2] = 'large' then coalesce((v_prices->>'goldLargeSurcharge')::numeric, 0) else 0 end;

    elsif v_parts[1] = 'goldmini' then
      -- goldmini:<sabji>:<raita|sweet>
      if coalesce(array_length(v_parts, 1), 0) <> 3 or v_parts[3] not in ('raita', 'sweet') then
        raise exception 'INVALID_ORDER: invalid Homely Gold Mini choice';
      end if;
      if not coalesce((v_enabled->>'goldMini')::boolean, true) then raise exception 'ITEM_UNAVAILABLE: Homely Gold Mini is not available today'; end if;
      if not (v_parts[2] = any(v_sabji_ids)) then raise exception 'ITEM_UNAVAILABLE: chosen sabji is not on today''s menu'; end if;
      v_unit_price := coalesce((v_prices->>'goldMini')::numeric, 0);

    elsif v_parts[1] = 'plan-standard' then
      -- plan-standard  |  plan-standard:chapati
      if not (v_item_id in ('plan-standard', 'plan-standard:chapati')) then raise exception 'INVALID_ORDER: invalid Homely Standard choice'; end if;
      if not coalesce((v_enabled->>'standard')::boolean, true) then raise exception 'ITEM_UNAVAILABLE: Homely Standard is not available today'; end if;
      v_unit_price := coalesce((v_prices->>'standard')::numeric, 0);

    elsif v_parts[1] = 'mini' then
      -- mini:<non-premium sabji>  |  mini:<sabji>:rice
      if coalesce(array_length(v_parts, 1), 0) not in (2, 3) or (array_length(v_parts, 1) = 3 and v_parts[3] <> 'rice') then
        raise exception 'INVALID_ORDER: invalid Homely Mini choice';
      end if;
      if not coalesce((v_enabled->>'mini')::boolean, true) then raise exception 'ITEM_UNAVAILABLE: Homely Mini is not available today'; end if;
      if not (v_parts[2] = any(v_nonprem_ids)) then raise exception 'ITEM_UNAVAILABLE: chosen sabji is not available for Homely Mini today'; end if;
      v_unit_price := coalesce((v_prices->>'mini')::numeric, 0);

    elsif v_item_id in ('extra-raita', 'extra-salad', 'extra-sweet') then
      if not coalesce((v_enabled->>(substr(v_item_id, 7)))::boolean, true) then
        raise exception 'ITEM_UNAVAILABLE: % of the day is not available today', initcap(substr(v_item_id, 7));
      end if;
      v_unit_price := coalesce((v_prices->>(substr(v_item_id, 7)))::numeric, 0);

    else
      -- Regular à la carte item (e.g. extra rotis): must exist on the menu and be marked available.
      select elem into v_menu_item from jsonb_array_elements(coalesce(v_menu->'items', '[]'::jsonb)) elem
      where elem->>'id' = v_item_id limit 1;
      if v_menu_item is null then raise exception 'ITEM_UNAVAILABLE: an item in your cart is no longer on the menu'; end if;
      if not coalesce((v_menu_item->>'available')::boolean, false) then
        raise exception 'ITEM_UNAVAILABLE: % is not available right now', coalesce(v_menu_item->>'name', 'an item');
      end if;
      v_unit_price := coalesce((v_menu_item->>'price')::numeric, 0);
    end if;

    v_computed_total := v_computed_total + (v_unit_price * v_qty);
    v_item_count := v_item_count + 1;
  end loop;

  if v_computed_total <= 0 then raise exception 'INVALID_ORDER: order total must be more than zero'; end if;

  -- 4. Promo / referral (unchanged rules).
  v_code := coalesce(nullif(p_order->>'promoCode', ''), nullif(p_order->>'referralCode', ''));
  if v_code is not null then
    v_code_upper := upper(trim(v_code));

    select elem into v_promo
    from jsonb_array_elements(coalesce(v_promo_codes, '[]'::jsonb)) elem
    where coalesce((elem->>'active')::boolean, true) = true
      and upper(coalesce(elem->>'code', '')) = v_code_upper
    limit 1;

    if v_promo is not null then
      v_min_order := coalesce((v_promo->>'minOrder')::numeric, 0);
      if v_min_order > 0 and v_computed_total < v_min_order then
        v_discount := 0;
      else
        if v_promo->>'type' = 'percent' then
          v_discount := round(v_computed_total * least(greatest(coalesce((v_promo->>'value')::numeric, 0), 0), 100) / 100);
        else
          v_discount := greatest(0, round(coalesce((v_promo->>'value')::numeric, 0)));
        end if;
        v_discount := least(v_discount, v_computed_total);
        v_kind := 'promo';
        v_promo_code_out := v_promo->>'code';
        v_promo_label_out := coalesce(v_promo->>'description', v_promo->>'code');
      end if;

    elsif v_referral_config is not null
      and coalesce((v_referral_config->>'enabled')::boolean, true)
      and v_code_upper ~ '^HT[0-9]{8}$'
    then
      select c.phone, c.name into v_referrer_phone, v_referrer_name
      from public.customers c
      where ('HT' || right(regexp_replace(c.phone, '\D', '', 'g'), 8)) = v_code_upper
        and coalesce(c.total_orders, 0) >= 1
      limit 1;

      if v_referrer_phone is not null
         and ('HT' || right(regexp_replace(v_phone, '\D', '', 'g'), 8)) <> v_code_upper
      then
        select count(*) into v_existing_orders from public.orders where phone = v_phone;
        if v_existing_orders = 0 then
          v_min_order := coalesce((v_referral_config->>'minOrder')::numeric, 0);
          if v_min_order = 0 or v_computed_total >= v_min_order then
            v_discount := least(greatest(coalesce((v_referral_config->>'referredDiscount')::numeric, 0), 0), v_computed_total);
            v_kind := 'referral';
            v_referral_code_out := v_code_upper;
          end if;
        end if;
      end if;
    end if;
  end if;

  v_final_total := greatest(0, v_computed_total - v_discount);

  -- 5. Save. The date is always today in IST (never the customer's phone clock).
  insert into public.orders (
    id, phone, customer_name, tower, flat, address, items, total,
    status, payment_mode, promo_code, referral_code, notes, date,
    created_at, extra
  ) values (
    p_order->>'id', v_phone, v_name, v_tower, v_flat,
    p_order->>'address',
    p_order->'items',
    v_final_total,
    'pending',
    p_order->>'paymentMode',
    v_promo_code_out,
    v_referral_code_out,
    left(p_order->>'notes', 1000),
    v_date,
    now(),
    (p_order - 'id' - 'phone' - 'customerName' - 'tower' - 'flat' - 'address'
              - 'items' - 'total' - 'status' - 'paymentMode' - 'promoCode'
              - 'referralCode' - 'notes' - 'date' - 'createdAt')
      || jsonb_build_object(
           'originalTotal', v_computed_total,
           'discount', v_discount,
           'promoLabel', v_promo_label_out,
           'referrerPhone', v_referrer_phone,
           'referrerName', v_referrer_name,
           'referrerRewardPending', (v_kind = 'referral')
         )
  )
  on conflict (id) do nothing
  returning id into v_inserted_id;

  -- Same order submitted twice (double tap / retry): don't count the customer twice.
  if v_inserted_id is null then
    return (select jsonb_build_object('total', total, 'discount', coalesce((extra->>'discount')::numeric, 0),
              'originalTotal', coalesce((extra->>'originalTotal')::numeric, total), 'kind', 'duplicate')
            from public.orders where id = p_order->>'id');
  end if;

  insert into public.customers (phone, name, tower, flat, total_orders, total_spent, first_order_date, last_order_date)
  values (v_phone, v_name, v_tower, v_flat, 1, v_final_total, v_date, v_date)
  on conflict (phone) do update set
    total_orders    = customers.total_orders + 1,
    total_spent     = customers.total_spent + v_final_total,
    last_order_date = v_date,
    tower           = v_tower,
    flat            = v_flat,
    name            = v_name,
    updated_at      = now();

  return jsonb_build_object('total', v_final_total, 'discount', v_discount, 'originalTotal', v_computed_total, 'kind', v_kind);
end;
$function$;

-- Bookkeeping so future tooling knows these ran (same versions as staging).
insert into supabase_migrations.schema_migrations (version, name) values
 ('20261003193558','customer_profiles_001_schema'),('20261003193808','customer_profiles_002_engine'),
 ('20261003193852','customer_profiles_002b_fix_refresh'),('20261003193947','customer_profiles_003_triggers_cron'),
 ('20261003194203','customer_profiles_004a_helpers_form_rpcs'),('20261003194424','customer_profiles_004b_staff_rpcs'),
 ('20261003194611','customer_profiles_004c_report_rpc'),('20261003194704','customer_profiles_004d_report_rpc_fix'),
 ('20261003195952','customer_profiles_005_token_table_deny_policy'),('20261003221329','pref_form_status_for_order'),
 ('20261003225247','customer_profiles_006_remove_consent'),('20261004103449','customer_profiles_007_report_timeout_fix'),
 ('20261005185127','customer_profiles_008_delete_inactive'),('20261005190000','menu_photos_storage_bucket'),
 ('20261005195935','place_order_full_validation')
on conflict do nothing;

commit;

-- ✅ If you see one row below with all "true", everything worked.
select
  (select count(*) from public.customer_identities) > 0                                   as customers_profiled,
  exists (select 1 from storage.buckets where id = 'menu-photos')                         as photo_bucket_ready,
  position('KITCHEN_CLOSED' in pg_get_functiondef('public.place_order'::regproc)) > 0      as order_checks_live,
  exists (select 1 from cron.job where jobname = 'cx-refresh-all-daily')                  as daily_refresh_scheduled;