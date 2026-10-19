-- Customer accounts — step 5: Homely Points and free-dish vouchers at checkout.
--
-- place_order is unchanged for every order that doesn't send "redeemPoints"
-- or "voucherId" (guest checkout, and signed-in customers not using rewards).
-- When they are sent:
--   * the caller must be the signed-in customer whose phone is on the order
--     (verified phone from auth.users — never trusted from the payload)
--   * a voucher must be theirs, available, and its meal must be in the cart;
--     it takes one unit of that meal off at today's price
--   * points: at least minRedeem, at most their balance, and at most
--     maxRedeemPct of what's left to pay; converted at pointValue ₹/point
-- The points discount is folded into extra.discount / promoLabel so the
-- owner dashboard and analytics (gross vs net) treat it like any discount.
-- If the order is later rejected, the loyalty trigger returns the points /
-- voucher.
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
  -- rewards
  v_variant_prices   jsonb := '{}'::jsonb;
  v_variant          text;
  v_redeem_txt       text;
  v_redeem_req       int := 0;
  v_voucher_id       text;
  v_my_phones        text[];
  v_loy              jsonb;
  v_voucher          public.reward_vouchers;
  v_voucher_disc     numeric := 0;
  v_points_disc      numeric := 0;
  v_points_used      int := 0;
  v_point_value      numeric;
  v_balance          int;
  v_payable          numeric;
begin
  if coalesce((select value #>> '{}' from public.app_data where key = 'ht_kitchen_open'), 'true') = 'false' then
    raise exception 'KITCHEN_CLOSED' using hint = 'The kitchen is closed and not accepting orders right now.';
  end if;

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
  v_plans_ok := v_plan_config is not null and v_plan_config->>'date' = v_date
    and coalesce(array_length(v_sabji_ids, 1), 0) = 3
    and coalesce(trim(v_plan_config->>'rice'), '') <> '' and coalesce(trim(v_plan_config->>'salad'), '') <> ''
    and coalesce(trim(v_plan_config->>'raita'), '') <> '' and coalesce(trim(v_plan_config->>'sweet'), '') <> '';

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
      if coalesce(array_length(v_parts, 1), 0) <> 3 or v_parts[3] not in ('raita', 'sweet') then
        raise exception 'INVALID_ORDER: invalid Homely Gold Mini choice';
      end if;
      if not coalesce((v_enabled->>'goldMini')::boolean, true) then raise exception 'ITEM_UNAVAILABLE: Homely Gold Mini is not available today'; end if;
      if not (v_parts[2] = any(v_sabji_ids)) then raise exception 'ITEM_UNAVAILABLE: chosen sabji is not on today''s menu'; end if;
      v_unit_price := coalesce((v_prices->>'goldMini')::numeric, 0);

    elsif v_parts[1] = 'plan-standard' then
      if not (v_item_id in ('plan-standard', 'plan-standard:chapati')) then raise exception 'INVALID_ORDER: invalid Homely Standard choice'; end if;
      if not coalesce((v_enabled->>'standard')::boolean, true) then raise exception 'ITEM_UNAVAILABLE: Homely Standard is not available today'; end if;
      v_unit_price := coalesce((v_prices->>'standard')::numeric, 0);

    elsif v_parts[1] = 'mini' then
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
      select elem into v_menu_item from jsonb_array_elements(coalesce(v_menu->'items', '[]'::jsonb)) elem
      where elem->>'id' = v_item_id limit 1;
      if v_menu_item is null then raise exception 'ITEM_UNAVAILABLE: an item in your cart is no longer on the menu'; end if;
      if not coalesce((v_menu_item->>'available')::boolean, false) then
        raise exception 'ITEM_UNAVAILABLE: % is not available right now', coalesce(v_menu_item->>'name', 'an item');
      end if;
      v_unit_price := coalesce((v_menu_item->>'price')::numeric, 0);
    end if;

    -- Remember each meal's unit price (for free-dish vouchers).
    v_variant := cx.item_variant(v_item_id);
    if v_variant is not null then
      v_variant_prices := v_variant_prices || jsonb_build_object(v_variant,
        greatest(coalesce((v_variant_prices->>v_variant)::numeric, 0), v_unit_price));
    end if;

    v_computed_total := v_computed_total + (v_unit_price * v_qty);
    v_item_count := v_item_count + 1;
  end loop;

  if v_computed_total <= 0 then raise exception 'INVALID_ORDER: order total must be more than zero'; end if;

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

  -- ── Rewards (signed-in customers only) ──
  v_redeem_txt := coalesce(nullif(p_order->>'redeemPoints', ''), '0');
  if v_redeem_txt !~ '^\d{1,7}$' then raise exception 'INVALID_ORDER: invalid points'; end if;
  v_redeem_req := v_redeem_txt::int;
  v_voucher_id := nullif(p_order->>'voucherId', '');

  if v_redeem_req > 0 or v_voucher_id is not null then
    v_my_phones := cx.my_phones();
    if v_my_phones is null or not (v_phone = any(v_my_phones)) then
      raise exception 'INVALID_ORDER: please sign in to My Homely to use your rewards';
    end if;
    -- One rewards checkout at a time per customer (no double-spend).
    perform pg_advisory_xact_lock(hashtext('homely-loyalty:' || cx.loyalty_group_key(v_phone)));
    v_loy := cx.loyalty_config();
  end if;

  if v_voucher_id is not null then
    select * into v_voucher from public.reward_vouchers
    where id = v_voucher_id and phone = any(v_my_phones) and status = 'available'
    for update;
    if v_voucher.id is null then raise exception 'INVALID_ORDER: this reward is no longer available'; end if;
    if (v_variant_prices->>v_voucher.variant) is null then
      raise exception 'INVALID_ORDER: add a % to your cart to use this reward',
        coalesce((select label from public.variant_map where variant = v_voucher.variant), 'matching meal');
    end if;
    v_voucher_disc := least((v_variant_prices->>v_voucher.variant)::numeric, v_computed_total - v_discount);
    v_promo_label_out := concat_ws(' + ', v_promo_label_out, v_voucher.label);
  end if;

  if v_redeem_req > 0 then
    if not coalesce((v_loy->>'enabled')::boolean, false) then
      raise exception 'INVALID_ORDER: Homely Points can''t be used right now';
    end if;
    v_point_value := coalesce((v_loy->>'pointValue')::numeric, 0);
    if v_point_value <= 0 then raise exception 'INVALID_ORDER: Homely Points can''t be used right now'; end if;
    if v_redeem_req < coalesce((v_loy->>'minRedeem')::int, 0) then
      raise exception 'INVALID_ORDER: use at least % Homely Points', (v_loy->>'minRedeem');
    end if;
    v_balance := cx.points_balance(v_my_phones);
    if v_redeem_req > v_balance then raise exception 'INVALID_ORDER: you have only % Homely Points', v_balance; end if;
    v_payable := v_computed_total - v_discount - v_voucher_disc;
    v_points_disc := least(floor(v_redeem_req * v_point_value),
                           floor(v_payable * least(greatest(coalesce((v_loy->>'maxRedeemPct')::numeric, 100), 0), 100) / 100));
    v_points_disc := greatest(v_points_disc, 0);
    v_points_used := ceil(v_points_disc / v_point_value)::int;
    if v_points_used > 0 then
      v_promo_label_out := concat_ws(' + ', v_promo_label_out, format('%s Homely Points', v_points_used));
    end if;
  end if;

  v_discount := v_discount + v_voucher_disc + v_points_disc;
  v_final_total := greatest(0, v_computed_total - v_discount);

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
              - 'referralCode' - 'notes' - 'date' - 'createdAt'
              - 'redeemPoints' - 'voucherId')
      || jsonb_build_object(
           'originalTotal', v_computed_total,
           'discount', v_discount,
           'promoLabel', v_promo_label_out,
           'referrerPhone', v_referrer_phone,
           'referrerName', v_referrer_name,
           'referrerRewardPending', (v_kind = 'referral'),
           'pointsRedeemed', v_points_used,
           'pointsDiscount', v_points_disc,
           'voucherId', v_voucher.id,
           'voucherDiscount', v_voucher_disc
         )
  )
  on conflict (id) do nothing
  returning id into v_inserted_id;

  if v_inserted_id is null then
    return (select jsonb_build_object('total', total, 'discount', coalesce((extra->>'discount')::numeric, 0),
              'originalTotal', coalesce((extra->>'originalTotal')::numeric, total), 'kind', 'duplicate')
            from public.orders where id = p_order->>'id');
  end if;

  if v_points_used > 0 then
    insert into public.loyalty_ledger (id, phone, points, kind, order_id, note)
    values ('redeem:' || v_inserted_id, v_phone, -v_points_used, 'redeem', v_inserted_id, 'Used on your order');
  end if;
  if v_voucher.id is not null then
    update public.reward_vouchers set status = 'used', used_order_id = v_inserted_id, used_at = now()
    where id = v_voucher.id;
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

  return jsonb_build_object('total', v_final_total, 'discount', v_discount, 'originalTotal', v_computed_total, 'kind', v_kind,
                            'pointsRedeemed', v_points_used, 'pointsDiscount', v_points_disc, 'voucherDiscount', v_voucher_disc);
end;
$function$;
