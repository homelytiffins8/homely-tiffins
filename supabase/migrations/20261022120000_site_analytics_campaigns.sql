-- Visitors tab: campaign breakdown.
--
-- site_analytics() gains a 'campaigns' list: one row per tagged link
-- (utm_source + utm_campaign) for visits in the chosen dates / meal / kitchen.
-- A visit belongs to the tags it STARTED with, like 'sources'. Untagged visits
-- (direct, referring websites) are left out.
--   visits, visitors   visits that started from that link
--   carted             visits that added anything to the cart
--   order_visits       visits that placed at least one order
--   orders, customers  orders placed in those visits; distinct phone numbers
--   revenue            order totals, rejected / cancelled orders excluded
-- campaign is '' when the link had a utm_source but no utm_campaign.
--
-- Only adds a key, so the dashboard already in production keeps working.

-- ── Owner summary ─────────────────────────────────────────────
-- A session is placed in a date and meal period by its START (first
-- server timestamp, IST): lunch = before 16:00, dinner = 16:00 onwards.
-- Its whole funnel stays there even if it runs past 4 PM or midnight.
-- Kitchen filter uses the status recorded when the session started;
-- sessions with no recorded status only appear under 'all'.
create or replace function public.site_analytics(
  p_from date, p_to date, p_meal text default 'all', p_kitchen text default 'all')
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with win as (
    -- one extra day each side so sessions that cross midnight are whole
    select * from public.site_events
    where created_at >= ((p_from - 1)::timestamp at time zone 'Asia/Kolkata')
      and created_at <  ((p_to + 2)::timestamp at time zone 'Asia/Kolkata')
  ),
  sess_all as (
    select session_id,
           min(created_at) as started_at,
           (array_agg(visitor_id order by created_at, id))[1] as visitor_id,
           bool_or(is_returning) as is_returning,
           (array_agg(device order by created_at, id))[1] as device,
           bool_or(installed) as installed,
           (array_agg(coalesce(nullif(utm_source, ''), nullif(referrer, ''), 'direct') order by created_at, id))[1] as source,
           (array_agg(nullif(utm_source, '') order by created_at, id))[1] as utm_source,
           (array_agg(nullif(utm_campaign, '') order by created_at, id))[1] as utm_campaign,
           (array_agg(session_kitchen_open order by created_at, id)
              filter (where session_kitchen_open is not null))[1] as kitchen_at_start,
           (array_agg(coalesce(tracking_version, 1) order by created_at, id))[1] >= 2 as detailed,
           (bool_or(event_name = 'kitchen_change') or count(distinct kitchen_open) > 1) as kitchen_changed
    from win
    group by session_id
  ),
  sess_dm as (
    -- date + meal selection (kitchen filter applied separately below)
    select s.*,
           (s.started_at at time zone 'Asia/Kolkata')::date as day,
           case when extract(hour from s.started_at at time zone 'Asia/Kolkata') < 16
                then 'lunch' else 'dinner' end as meal
    from sess_all s
    where s.started_at >= (p_from::timestamp at time zone 'Asia/Kolkata')
      and s.started_at <  ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
  ),
  sess_meal as (
    select * from sess_dm where p_meal = 'all' or meal = p_meal
  ),
  sel as (
    select * from sess_meal
    where p_kitchen = 'all'
       or (p_kitchen = 'open'   and kitchen_at_start is true)
       or (p_kitchen = 'closed' and kitchen_at_start is false)
  ),
  ev as (
    select w.* from win w join sel using (session_id)
  ),
  ord_meal as (
    -- one row per placed order (first event wins), sessions in date + meal.
    -- props fallback covers rows from the previous app version.
    select distinct on (coalesce(w.order_id, w.props->>'order_id'))
           coalesce(w.order_id, w.props->>'order_id') as order_id, w.session_id, w.created_at
    from win w join sess_meal m using (session_id)
    where w.event_name = 'order_placed' and coalesce(w.order_id, w.props->>'order_id') is not null
    order by coalesce(w.order_id, w.props->>'order_id'), w.created_at, w.id
  ),
  ord as (
    select o.* from ord_meal o join sel using (session_id)
  ),
  ord_lines as (
    select o.order_id, o.session_id, o.created_at,
           case
             when i->>'id' like 'goldmini:%'     then 'goldMini'
             when i->>'id' like 'gold:%'         then 'gold'
             when i->>'id' like 'plan-standard%' then 'standard'
             when i->>'id' like 'mini:%'         then 'mini'
           end as variant,
           case when (i->>'qty') ~ '^[0-9]+(\.[0-9]+)?$' then (i->>'qty')::numeric else 0 end as qty
    from ord o
    join public.orders r on r.id = o.order_id
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(r.items) = 'array' then r.items else '[]'::jsonb end) i
  ),
  views as (
    select session_id, coalesce(variant, props->>'plan') as variant, min(created_at) as first_view
    from ev
    where event_name = 'plan_open'
      and coalesce(variant, props->>'plan') in ('mini', 'standard', 'goldMini', 'gold')
    group by 1, 2
  ),
  vlist(variant, label, sort) as (
    values ('mini', 'Homely Mini', 1), ('standard', 'Homely Standard', 2),
           ('goldMini', 'Homely Gold Mini', 3), ('gold', 'Homely Gold', 4)
  ),
  vstats as (
    select v.variant, v.label, v.sort,
      (select count(*) from views w where w.variant = v.variant) as view_visits,
      (select count(*) from views w join sel s using (session_id)
        where w.variant = v.variant and s.detailed) as view_visits_tracked,
      (select count(distinct a.session_id) from ev a
        where a.event_name = 'variant_add' and a.variant = v.variant) as add_visits,
      (select count(*) from views w join sel s using (session_id)
        where w.variant = v.variant and s.detailed
          and exists (select 1 from ev a where a.session_id = w.session_id and a.event_name = 'variant_add'
                        and a.variant = v.variant and a.created_at >= w.first_view)) as view_then_add,
      (select count(distinct l.session_id) from ord_lines l where l.variant = v.variant) as order_visits,
      (select count(*) from views w
        where w.variant = v.variant
          and exists (select 1 from ord_lines l where l.session_id = w.session_id
                        and l.variant = v.variant and l.created_at >= w.first_view)) as view_then_order,
      (select coalesce(sum(l.qty), 0) from ord_lines l where l.variant = v.variant) as units
    from vlist v
  ),
  tagged as (
    select session_id, visitor_id,
           coalesce(utm_source, '') as source, coalesce(utm_campaign, '') as campaign
    from sel
    where utm_source is not null or utm_campaign is not null
  ),
  tag_orders as (
    select t.source, t.campaign, r.phone, r.total, r.status
    from ord o
    join tagged t using (session_id)
    join public.orders r on r.id = o.order_id
  )
  select jsonb_build_object(
    'filters', jsonb_build_object('from', p_from, 'to', p_to, 'meal', p_meal, 'kitchen', p_kitchen),
    'totals', (
      select jsonb_build_object(
        'visitors',           count(distinct visitor_id),
        'sessions',           count(*),
        'returning_visitors', count(distinct visitor_id) filter (where is_returning),
        'mobile_sessions',    count(*) filter (where device = 'mobile'),
        'installed_sessions', count(*) filter (where installed),
        'detailed_sessions',  count(*) filter (where detailed),
        'kitchen_changed',    count(*) filter (where kitchen_changed),
        'order_visits',       (select count(distinct session_id) from ord),
        'orders',             (select count(*) from ord)
      ) from sel
    ),
    'kitchen', (
      -- for the chosen dates + meal, regardless of the kitchen filter
      select jsonb_build_object(
        'open_visits',         count(*) filter (where kitchen_at_start is true),
        'closed_visits',       count(*) filter (where kitchen_at_start is false),
        'unknown_visits',      count(*) filter (where kitchen_at_start is null),
        'changed_visits',      count(*) filter (where kitchen_changed),
        'open_visits_ordered', count(*) filter (where kitchen_at_start is true
                                 and session_id in (select session_id from ord_meal))
      ) from sess_meal
    ),
    'funnel', (
      select coalesce(jsonb_object_agg(event_name, jsonb_build_object(
               'sessions', sessions, 'visitors', visitors, 'events', events)), '{}'::jsonb)
      from (
        select event_name,
               count(distinct session_id) as sessions,
               count(distinct visitor_id) as visitors,
               count(*)                   as events
        from ev
        where event_name not in ('visit', 'order_placed')
        group by event_name
      ) f
    ) || jsonb_build_object(
      'visit', (select jsonb_build_object('sessions', count(*), 'visitors', count(distinct visitor_id), 'events', count(*)) from sel),
      'order_placed', (select jsonb_build_object('sessions', count(distinct o.session_id),
                                                 'visitors', count(distinct s.visitor_id),
                                                 'events', count(*))
                       from ord o join sel s using (session_id))
    ),
    'sources', (
      select coalesce(jsonb_agg(x order by x.sessions desc), '[]'::jsonb)
      from (
        select s.source,
               count(*) as sessions,
               count(*) filter (where s.session_id in (select session_id from ord)) as orders
        from sel s
        group by s.source
        order by count(*) desc
        limit 10
      ) x
    ),
    'campaigns', (
      select coalesce(jsonb_agg(x order by x.visits desc, x.source, x.campaign), '[]'::jsonb)
      from (
        select t.source, t.campaign,
               count(*) as visits,
               count(distinct t.visitor_id) as visitors,
               count(*) filter (where exists (select 1 from ev a where a.session_id = t.session_id
                                               and a.event_name in ('add_to_cart', 'variant_add'))) as carted,
               count(*) filter (where t.session_id in (select session_id from ord)) as order_visits,
               (select count(*) from tag_orders o
                 where o.source = t.source and o.campaign = t.campaign) as orders,
               (select count(distinct o.phone) from tag_orders o
                 where o.source = t.source and o.campaign = t.campaign) as customers,
               (select coalesce(sum(o.total), 0) from tag_orders o
                 where o.source = t.source and o.campaign = t.campaign
                   and coalesce(o.status, '') not in ('rejected', 'cancelled')) as revenue
        from tagged t
        group by t.source, t.campaign
        order by count(*) desc
        limit 20
      ) x
    ),
    'daily', (
      select coalesce(jsonb_agg(d order by d.day), '[]'::jsonb)
      from (
        select g.day::date as day,
               count(distinct s.visitor_id) as visitors,
               count(s.session_id) as sessions,
               count(s.session_id) filter (where s.session_id in (select session_id from ord)) as orders
        from generate_series(p_from, p_to, interval '1 day') g(day)
        left join sel s on s.day = g.day::date
        group by g.day
      ) d
    ),
    'variants', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'variant', variant, 'label', label,
               'view_visits', view_visits, 'view_visits_tracked', view_visits_tracked,
               'add_visits', add_visits, 'view_then_add', view_then_add,
               'order_visits', order_visits, 'view_then_order', view_then_order,
               'units', units) order by sort), '[]'::jsonb)
      from vstats
    ),
    -- kept for the dashboard version already in production
    'plans', (
      select coalesce(jsonb_agg(jsonb_build_object('plan', variant, 'sessions', view_visits) order by view_visits desc), '[]'::jsonb)
      from vstats where view_visits > 0
    ),
    'tracking', jsonb_build_object(
      'tracking_since', (select min(created_at) from public.site_events),
      'detailed_since', (select min(created_at) from public.site_events where tracking_version >= 2)
    )
  );
$$;

revoke all on function public.site_analytics(date, date, text, text) from public, anon;
grant execute on function public.site_analytics(date, date, text, text) to authenticated;
