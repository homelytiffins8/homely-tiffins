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
