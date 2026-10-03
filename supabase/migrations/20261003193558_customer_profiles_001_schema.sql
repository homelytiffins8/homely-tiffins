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