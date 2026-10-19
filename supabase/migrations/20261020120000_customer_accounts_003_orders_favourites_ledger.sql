-- Customer accounts — step 3: My Orders, My Favourites, My Regular, credit ledger.
-- All scoped to cx.my_phones() (the signed-in customer's verified phone plus
-- any phone the owner merged into the same identity).

-- Order-again key: the customer's choices without the day's sabji slots,
-- which change every day (sabji ids are per-day menu slots, not dishes).
--   gold:large:chapati4:a+b:raita -> gold:large:chapati4:*:raita
--   goldmini:a:sweet              -> goldmini:*:sweet
--   mini:a / mini:a:rice          -> mini:* / mini:*:rice
create or replace function cx.reorder_key(p_item_id text)
returns text
language sql
immutable
set search_path to ''
as $$
  select case
    when p_item_id like 'gold:%' then regexp_replace(p_item_id, '^(gold:[^:]*:[^:]*):[^:]*:(.*)$', '\1:*:\2')
    when p_item_id like 'goldmini:%' then regexp_replace(p_item_id, '^goldmini:[^:]*', 'goldmini:*')
    when p_item_id like 'mini:%' then regexp_replace(p_item_id, '^mini:[^:]*', 'mini:*')
    else p_item_id
  end
$$;

-- Customer-safe view of one order (no referrer phone, no internal fields).
create or replace function cx.customer_order_json(o public.orders)
returns jsonb
language sql
stable
set search_path to ''
as $$
  select jsonb_build_object(
    'id', o.id,
    'date', o.date,
    'createdAt', o.created_at,
    'status', o.status,
    'total', o.total,
    'originalTotal', coalesce((o.extra ->> 'originalTotal')::numeric, o.total),
    'discount', coalesce((o.extra ->> 'discount')::numeric, 0),
    'promoLabel', o.extra ->> 'promoLabel',
    'pointsRedeemed', coalesce((o.extra ->> 'pointsRedeemed')::int, 0),
    'specialInstructions', o.extra ->> 'specialInstructions',
    'tower', o.tower,
    'flat', o.flat,
    'rated', o.extra ? 'rating',
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i ->> 'id', 'name', i ->> 'name',
        'qty', coalesce((i ->> 'qty')::numeric, 1), 'price', (i ->> 'price')::numeric))
      from jsonb_array_elements(o.items) i), '[]'::jsonb)
  )
$$;

create or replace function public.my_orders(p_limit int default 20, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare v_phones text[];
begin
  perform cx.require_customer();
  v_phones := cx.my_phones();
  return coalesce((
    select jsonb_agg(cx.customer_order_json(o) order by o.created_at desc)
    from (
      select * from public.orders
      where phone = any(v_phones)
      order by created_at desc
      limit least(greatest(coalesce(p_limit, 20), 1), 100)
      offset greatest(coalesce(p_offset, 0), 0)
    ) o
  ), '[]'::jsonb);
end $$;

-- Pin one delivered order as "My Regular" (null clears it).
create or replace function public.set_my_regular(p_order_id text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare v_phone text := cx.require_customer();
begin
  if p_order_id is not null and not exists (
    select 1 from public.orders where id = p_order_id and phone = any(cx.my_phones())
  ) then
    raise exception 'NOT_FOUND: order not found';
  end if;
  insert into public.customer_accounts (user_id, phone) values (auth.uid(), v_phone)
  on conflict (user_id) do nothing;
  update public.customer_accounts set regular_order_id = p_order_id, updated_at = now()
  where user_id = auth.uid();
  return jsonb_build_object('regularOrderId', p_order_id);
end $$;

-- Favourites, calculated from delivered orders only. Reuses the owner-side
-- customer analysis (customer_analysis / customer_dish_stats, refreshed by
-- the orders trigger) — nothing extra is stored for this.
create or replace function public.my_favourites()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_phone text := cx.require_customer();
  v_phones text[] := cx.my_phones();
  v_id uuid;
  v_a public.customer_analysis;
  v_regular jsonb;
  v_pinned jsonb;
  v_sabjis jsonb;
  v_sides jsonb;
  v_meals jsonb;
begin
  select cx.root_of(id) into v_id from public.customer_identities where phone_raw = v_phone;

  if v_id is not null then
    select * into v_a from public.customer_analysis where customer_id = v_id;
    if v_a.customer_id is null or v_a.as_of_date < cx.today_ist() then
      perform cx.refresh_customer(v_id);
      select * into v_a from public.customer_analysis where customer_id = v_id;
    end if;

    select jsonb_agg(jsonb_build_object('name', d.canonical_name, 'count', s.delivered_orders)
                     order by s.explicit_orders desc, s.delivered_orders desc)
      into v_sabjis
    from (select * from public.customer_dish_stats
          where customer_id = v_id and win = 'lifetime' and role_group = 'main' and category in ('sabji', 'dal')
          order by explicit_orders desc, delivered_orders desc limit 3) s
    join public.dish_catalog d on d.id = s.dish_id;

    -- Best raita, sweet and rice the customer actually chose.
    select jsonb_agg(x order by x ->> 'category')
      into v_sides
    from (
      select distinct on (s.category)
        jsonb_build_object('name', d.canonical_name, 'category', s.category, 'count', s.delivered_orders) x
      from public.customer_dish_stats s
      join public.dish_catalog d on d.id = s.dish_id
      where s.customer_id = v_id and s.win = 'lifetime' and s.category in ('raita', 'sweet', 'rice')
        and s.explicit_orders > 0
      order by s.category, s.explicit_orders desc, s.delivered_orders desc
    ) q;

    select jsonb_agg(jsonb_build_object('variant', k, 'label', coalesce(vm.label, k), 'count', (v)::int) order by (v)::int desc)
      into v_meals
    from jsonb_each_text(coalesce(v_a.variant_counts, '{}'::jsonb)) as e(k, v)
    left join public.variant_map vm on vm.variant = k;
  end if;

  -- Most-ordered combination (meal choices + extras), delivered orders only.
  with lines as (
    select o.id, o.created_at, i, cx.reorder_key(i ->> 'id') k
    from public.orders o, jsonb_array_elements(o.items) i
    where o.phone = any(v_phones) and o.status = 'delivered'
  ), per_order as (
    select id, max(created_at) created_at, string_agg(k, ' | ' order by k) combo
    from lines group by id
  ), top as (
    select combo, count(*) n, (array_agg(id order by created_at desc))[1] latest_id
    from per_order group by combo order by count(*) desc, max(created_at) desc limit 1
  )
  select jsonb_build_object('combo', t.combo, 'count', t.n, 'order', cx.customer_order_json(o))
    into v_regular
  from top t join public.orders o on o.id = t.latest_id;

  select cx.customer_order_json(o) into v_pinned
  from public.customer_accounts a join public.orders o on o.id = a.regular_order_id
  where a.user_id = auth.uid();

  return jsonb_build_object(
    'deliveredOrders', coalesce(v_a.delivered_orders, 0),
    'usualMeal', case when v_a.usual_variant is not null then jsonb_build_object(
        'variant', v_a.usual_variant,
        'label', coalesce((select label from public.variant_map where variant = v_a.usual_variant), v_a.usual_variant),
        'count', (v_a.variant_counts ->> v_a.usual_variant)::int) end,
    'meals', coalesce(v_meals, '[]'::jsonb),
    'topSabjis', coalesce(v_sabjis, '[]'::jsonb),
    'topSides', coalesce(v_sides, '[]'::jsonb),
    'preferredSlot', (select k from jsonb_each_text(coalesce(v_a.slot_counts, '{}'::jsonb)) e(k, v) order by v::int desc limit 1),
    'favouriteDay', (select k from jsonb_each_text(coalesce(v_a.weekday_counts, '{}'::jsonb)) e(k, v) order by v::int desc limit 1),
    'avgOrderValue', v_a.avg_order_value,
    'regular', coalesce(v_pinned, v_regular -> 'order'),
    'regularIsPinned', v_pinned is not null,
    'regularCount', v_regular -> 'count'
  );
end $$;

-- Credit ledger (owner convention: debit = order delivered, credit = payment
-- / reward). Balance > 0 means the customer owes that amount.
create or replace function public.my_ledger()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare v_phones text[];
begin
  perform cx.require_customer();
  v_phones := cx.my_phones();
  return jsonb_build_object(
    'balance', coalesce((select sum(case when type = 'debit' then amount else -amount end)
                         from public.credit_ledger where phone = any(v_phones)), 0),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id, 'date', created_at, 'type', type, 'amount', amount, 'note', note,
        'orderId', order_id, 'orderDetails', extra ->> 'orderDetails') order by created_at desc)
      from (select * from public.credit_ledger where phone = any(v_phones) order by created_at desc limit 200) l
    ), '[]'::jsonb)
  );
end $$;

revoke all on function cx.reorder_key(text) from public, anon, authenticated;
revoke all on function cx.customer_order_json(public.orders) from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array['public.my_orders(int,int)', 'public.set_my_regular(text)', 'public.my_favourites()', 'public.my_ledger()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
