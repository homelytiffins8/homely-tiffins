-- Customer accounts — step 4: Homely loyalty (points, milestone rewards, vouchers).
--
-- Config lives in cx_config key 'loyalty' (staff-only; edited from the owner
-- Loyalty tab through staff_loyalty_save):
-- {
--   "enabled": true,
--   "startedAt": "<timestamptz>",          -- set on first enable; orders before it never earn
--   "earn": { "mode": "per_order" | "per_amount" | "off",
--             "pointsPerOrder": 10,         -- per_order
--             "pointsPerStep": 1, "rupeesStep": 10 },   -- per_amount: 1 point per ₹10 paid
--   "pointValue": 1,                         -- ₹ value of 1 point at checkout
--   "minRedeem": 50,                         -- min points per redemption
--   "maxRedeemPct": 50,                      -- max % of an order payable with points
--   "milestones": [ { "id": "m1", "orders": 10, "repeat": true,
--                     "type": "points" | "cashback" | "free_dish",
--                     "points": 100, "amount": 50, "variant": "mini" } ]
-- }
-- Awards happen in the database when an order becomes delivered (trigger), so
-- they don't depend on which device the owner uses. Every award has a
-- deterministic id, so it can never be granted twice.

create table if not exists public.loyalty_ledger (
  id text primary key,
  phone text not null,
  points int not null,
  kind text not null check (kind in ('earn', 'milestone', 'redeem', 'refund', 'reversal', 'adjust')),
  order_id text references public.orders(id) on delete set null,
  note text,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists loyalty_ledger_phone_idx on public.loyalty_ledger(phone, created_at desc);
create index if not exists loyalty_ledger_order_idx on public.loyalty_ledger(order_id);

create table if not exists public.reward_vouchers (
  id text primary key,
  phone text not null,
  rule_id text,
  variant text not null,
  label text not null,
  status text not null default 'available' check (status in ('available', 'used', 'void')),
  issued_order_id text references public.orders(id) on delete set null,
  used_order_id text references public.orders(id) on delete set null,
  issued_at timestamptz not null default now(),
  used_at timestamptz
);
create index if not exists reward_vouchers_phone_idx on public.reward_vouchers(phone, status);

alter table public.loyalty_ledger enable row level security;
alter table public.reward_vouchers enable row level security;
drop policy if exists loyalty_ledger_staff_read on public.loyalty_ledger;
create policy loyalty_ledger_staff_read on public.loyalty_ledger for select to authenticated using ((select public.is_staff()));
drop policy if exists reward_vouchers_staff_read on public.reward_vouchers;
create policy reward_vouchers_staff_read on public.reward_vouchers for select to authenticated using ((select public.is_staff()));

insert into public.cx_config (key, value) values ('loyalty', jsonb_build_object(
  'enabled', false,
  'earn', jsonb_build_object('mode', 'per_order', 'pointsPerOrder', 10, 'pointsPerStep', 1, 'rupeesStep', 10),
  'pointValue', 1, 'minRedeem', 50, 'maxRedeemPct', 50,
  'milestones', '[]'::jsonb
)) on conflict (key) do nothing;

-- Meal variant keys used by vouchers (same keys as variant_map).
create or replace function cx.item_variant(p_item_id text)
returns text
language sql
immutable
set search_path to ''
as $$
  select case
    when p_item_id like 'gold:large:%' then 'goldLarge'
    when p_item_id like 'gold:%' then 'goldMedium'
    when p_item_id like 'goldmini:%' then 'goldMini'
    when p_item_id like 'plan-standard%' then 'standard'
    when p_item_id like 'mini:%' then 'mini'
    else null
  end
$$;

create or replace function cx.loyalty_config()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$ select value from public.cx_config where key = 'loyalty' $$;

create or replace function cx.loyalty_group_key(p_phone text)
returns text
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce((select cx.root_of(id)::text from public.customer_identities where phone_raw = p_phone), p_phone)
$$;

create or replace function cx.phones_of(p_phone text)
returns text[]
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(
    (select cx.group_phones(cx.root_of(id)) from public.customer_identities where phone_raw = p_phone),
    array[p_phone])
$$;

create or replace function cx.points_balance(p_phones text[])
returns int
language sql
stable
security definer
set search_path to ''
as $$ select coalesce(sum(points), 0)::int from public.loyalty_ledger where phone = any(p_phones) $$;

-- Award earn points + milestone rewards for a delivered order.
create or replace function cx.loyalty_award(o public.orders)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_cfg jsonb := cx.loyalty_config();
  v_start timestamptz;
  v_pts int := 0;
  v_mode text;
  v_cycle int;
  v_phones text[];
  v_group text;
  v_n int;
  v_every int;
  v_k int;
  m jsonb;
  v_id text;
  v_label text;
begin
  if v_cfg is null or not coalesce((v_cfg ->> 'enabled')::boolean, false) then return; end if;
  v_start := nullif(v_cfg ->> 'startedAt', '')::timestamptz;
  if v_start is not null and o.created_at < v_start then return; end if;

  -- Earn. The id carries a cycle number so a delivered → undelivered →
  -- delivered sequence nets out to exactly one award.
  v_mode := coalesce(v_cfg -> 'earn' ->> 'mode', 'off');
  if v_mode = 'per_order' then
    v_pts := greatest(coalesce((v_cfg -> 'earn' ->> 'pointsPerOrder')::int, 0), 0);
  elsif v_mode = 'per_amount' and coalesce((v_cfg -> 'earn' ->> 'rupeesStep')::numeric, 0) > 0 then
    v_pts := greatest(floor(o.total / (v_cfg -> 'earn' ->> 'rupeesStep')::numeric)::int
                      * coalesce((v_cfg -> 'earn' ->> 'pointsPerStep')::int, 0), 0);
  end if;
  if v_pts > 0 then
    select count(*) into v_cycle from public.loyalty_ledger where kind = 'reversal' and id like 'rev:earn:' || o.id || ':%';
    insert into public.loyalty_ledger (id, phone, points, kind, order_id, note)
    values ('earn:' || o.id || ':' || v_cycle, o.phone, v_pts, 'earn', o.id, 'Earned on your order')
    on conflict (id) do nothing;
  end if;

  -- Milestones: count delivered orders since loyalty started (across the
  -- customer's merged phones); fire when the count lands on a multiple.
  v_phones := cx.phones_of(o.phone);
  v_group := cx.loyalty_group_key(o.phone);
  select count(*) into v_n from public.orders
  where phone = any(v_phones) and status = 'delivered' and (v_start is null or created_at >= v_start);

  for m in select * from jsonb_array_elements(coalesce(v_cfg -> 'milestones', '[]'::jsonb)) loop
    v_every := coalesce((m ->> 'orders')::int, 0);
    continue when v_every < 1;
    if coalesce((m ->> 'repeat')::boolean, false) then
      continue when v_n % v_every <> 0;
      v_k := v_n / v_every;
    else
      continue when v_n <> v_every;
      v_k := 1;
    end if;
    v_id := format('ms:%s:%s:%s', m ->> 'id', v_group, v_k);
    v_label := format('%s-order reward', v_every);

    if m ->> 'type' = 'points' and coalesce((m ->> 'points')::int, 0) > 0 then
      insert into public.loyalty_ledger (id, phone, points, kind, order_id, note)
      values (v_id, o.phone, (m ->> 'points')::int, 'milestone', o.id, v_label)
      on conflict (id) do nothing;
    elsif m ->> 'type' = 'cashback' and coalesce((m ->> 'amount')::numeric, 0) > 0 then
      -- Cashback goes on the credit ledger (credit = reduces what they owe),
      -- so the owner Credit tab and the customer's ledger both show it.
      insert into public.credit_ledger (id, phone, order_id, amount, type, note, created_at, extra)
      values ('loy:' || v_id, o.phone, o.id, (m ->> 'amount')::numeric, 'credit',
              'Loyalty cashback — ' || v_label, now(), jsonb_build_object('loyaltyRule', m ->> 'id'))
      on conflict (id) do nothing;
    elsif m ->> 'type' = 'free_dish' and coalesce(m ->> 'variant', '') <> '' then
      insert into public.reward_vouchers (id, phone, rule_id, variant, label, issued_order_id)
      values (v_id, o.phone, m ->> 'id', m ->> 'variant',
              'Free ' || coalesce((select label from public.variant_map where variant = m ->> 'variant'), m ->> 'variant'),
              o.id)
      on conflict (id) do nothing;
    end if;
  end loop;
end $$;

-- Order left "delivered" (owner correction): take back what it earned.
create or replace function cx.loyalty_reverse_award(o public.orders)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare l record;
begin
  for l in select * from public.loyalty_ledger
           where order_id = o.id and kind in ('earn', 'milestone')
             and not exists (select 1 from public.loyalty_ledger r where r.id = 'rev:' || loyalty_ledger.id)
  loop
    insert into public.loyalty_ledger (id, phone, points, kind, order_id, note)
    values ('rev:' || l.id, l.phone, -l.points, 'reversal', o.id, 'Reversed — order not delivered')
    on conflict (id) do nothing;
  end loop;
  update public.reward_vouchers set status = 'void' where issued_order_id = o.id and status = 'available';
  delete from public.credit_ledger where id like 'loy:%' and order_id = o.id;
end $$;

-- Order rejected: give back points / voucher used on it.
create or replace function cx.loyalty_refund_redemption(o public.orders)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare l public.loyalty_ledger;
begin
  select * into l from public.loyalty_ledger where id = 'redeem:' || o.id;
  if l.id is not null then
    insert into public.loyalty_ledger (id, phone, points, kind, order_id, note)
    values ('refund:' || o.id, l.phone, -l.points, 'refund', o.id, 'Returned — order was not accepted')
    on conflict (id) do nothing;
  end if;
  update public.reward_vouchers set status = 'available', used_order_id = null, used_at = null
  where used_order_id = o.id and status = 'used';
end $$;

create or replace function cx.trg_loyalty()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  begin
    if new.status = 'delivered' and (tg_op = 'INSERT' or old.status is distinct from 'delivered') then
      perform cx.loyalty_award(new);
    elsif tg_op = 'UPDATE' and old.status = 'delivered' and new.status <> 'delivered' then
      perform cx.loyalty_reverse_award(new);
    end if;
    if new.status = 'rejected' and (tg_op = 'INSERT' or old.status is distinct from 'rejected') then
      perform cx.loyalty_refund_redemption(new);
    end if;
  exception when others then
    -- Never let loyalty bookkeeping break an order status change.
    perform cx.log_error(null, new.id, 'loyalty_trigger', sqlerrm);
  end;
  return new;
end $$;

drop trigger if exists loyalty_orders on public.orders;
create trigger loyalty_orders after insert or update of status on public.orders
  for each row execute function cx.trg_loyalty();

-- ── Customer: rewards ──
create or replace function public.my_rewards()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_phone text := cx.require_customer();
  v_phones text[] := cx.my_phones();
  v_cfg jsonb := cx.loyalty_config();
  v_ref jsonb := (select value from public.app_data where key = 'ht_referral_config');
  v_start timestamptz := nullif(v_cfg ->> 'startedAt', '')::timestamptz;
  v_n int;
begin
  select count(*) into v_n from public.orders
  where phone = any(v_phones) and status = 'delivered' and (v_start is null or created_at >= v_start);

  return jsonb_build_object(
    'referralCode', 'HT' || right(v_phone, 8),
    'referral', jsonb_build_object(
      'enabled', coalesce((v_ref ->> 'enabled')::boolean, true),
      'referrerReward', coalesce((v_ref ->> 'referrerReward')::numeric, 0),
      'referredDiscount', coalesce((v_ref ->> 'referredDiscount')::numeric, 0),
      'earned', coalesce((select sum(amount) from public.credit_ledger where phone = any(v_phones) and id like 'ref:%'), 0),
      'count', (select count(*) from public.credit_ledger where phone = any(v_phones) and id like 'ref:%')),
    'loyalty', jsonb_build_object(
      'enabled', coalesce((v_cfg ->> 'enabled')::boolean, false),
      'earn', v_cfg -> 'earn',
      'pointValue', coalesce((v_cfg ->> 'pointValue')::numeric, 1),
      'minRedeem', coalesce((v_cfg ->> 'minRedeem')::int, 0),
      'maxRedeemPct', coalesce((v_cfg ->> 'maxRedeemPct')::int, 100),
      'milestones', coalesce((select jsonb_agg(jsonb_build_object(
          'id', m ->> 'id', 'orders', (m ->> 'orders')::int, 'repeat', coalesce((m ->> 'repeat')::boolean, false),
          'type', m ->> 'type', 'points', (m ->> 'points')::int, 'amount', (m ->> 'amount')::numeric,
          'variant', m ->> 'variant',
          'variantLabel', (select label from public.variant_map where variant = m ->> 'variant')))
        from jsonb_array_elements(coalesce(v_cfg -> 'milestones', '[]'::jsonb)) m), '[]'::jsonb),
      'deliveredSinceStart', v_n,
      'balance', cx.points_balance(v_phones),
      'history', coalesce((select jsonb_agg(jsonb_build_object(
          'id', id, 'points', points, 'kind', kind, 'note', note, 'orderId', order_id, 'date', created_at) order by created_at desc)
        from (select * from public.loyalty_ledger where phone = any(v_phones) order by created_at desc limit 50) h), '[]'::jsonb),
      'vouchers', coalesce((select jsonb_agg(jsonb_build_object(
          'id', id, 'variant', variant, 'label', label, 'status', status, 'issuedAt', issued_at, 'usedAt', used_at) order by issued_at desc)
        from public.reward_vouchers where phone = any(v_phones) and status <> 'void'), '[]'::jsonb)
    )
  );
end $$;

-- ── Customer: preference form link (reuses the existing preference form) ──
create or replace function public.my_pref_form_link()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare v_phone text := cx.require_customer(); v_id uuid; v_root uuid; v_tok text;
begin
  select id into v_id from public.customer_identities where phone_raw = v_phone;
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'order_first'); end if;
  v_root := cx.root_of(v_id);
  update public.preference_form_tokens set revoked_at = now()
  where id in (select id from public.preference_form_tokens where customer_id = v_root and kind = 'order_link'
                 and revoked_at is null and expires_at > now() order by id desc offset 4);
  v_tok := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.preference_form_tokens(customer_id, token_hash, kind, created_by, expires_at)
  values (v_root, encode(sha256(convert_to(v_tok, 'UTF8')), 'hex'), 'order_link', 'customer_account', now() + interval '1 day');
  return jsonb_build_object('ok', true, 'token', v_tok);
end $$;

-- ── Owner: loyalty settings + balances ──
create or replace function public.staff_loyalty_get()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
begin
  perform cx.require_staff();
  return jsonb_build_object(
    'config', cx.loyalty_config(),
    'variants', (select jsonb_agg(jsonb_build_object('variant', variant, 'label', label) order by tier)
                 from public.variant_map where is_meal),
    'totals', jsonb_build_object(
      'outstanding', (select coalesce(sum(points), 0) from public.loyalty_ledger),
      'earned', (select coalesce(sum(points), 0) from public.loyalty_ledger where kind in ('earn', 'milestone')),
      'redeemed', (select coalesce(-sum(points), 0) from public.loyalty_ledger where kind = 'redeem'),
      'vouchersAvailable', (select count(*) from public.reward_vouchers where status = 'available'),
      'cashbackGiven', (select coalesce(sum(amount), 0) from public.credit_ledger where id like 'loy:%'),
      'accounts', (select count(*) from public.customer_accounts)),
    'customers', coalesce((
      select jsonb_agg(r order by (r ->> 'balance')::int desc, r ->> 'name')
      from (
        select jsonb_build_object(
          'phone', p.phone,
          'name', coalesce(c.name, ci.display_name),
          'tower', coalesce(c.tower, ci.tower), 'flat', coalesce(c.flat, ci.flat),
          'balance', coalesce((select sum(points) from public.loyalty_ledger l where l.phone = p.phone), 0),
          'vouchers', (select count(*) from public.reward_vouchers v where v.phone = p.phone and v.status = 'available'),
          'hasAccount', exists (select 1 from public.customer_accounts a where a.phone = p.phone)) r
        from (select phone from public.loyalty_ledger union select phone from public.reward_vouchers) p
        left join public.customers c on c.phone = p.phone
        left join public.customer_identities ci on ci.phone_raw = p.phone
      ) x
    ), '[]'::jsonb)
  );
end $$;

create or replace function public.staff_loyalty_save(p_config jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_old jsonb := cx.loyalty_config();
  v_mode text := coalesce(p_config -> 'earn' ->> 'mode', 'off');
  v_ms jsonb := '[]'::jsonb;
  m jsonb;
  v_new jsonb;
begin
  perform cx.require_staff();
  if v_mode not in ('per_order', 'per_amount', 'off') then raise exception 'INVALID: earn mode'; end if;
  if coalesce((p_config ->> 'pointValue')::numeric, 0) <= 0 then raise exception 'INVALID: point value must be more than 0'; end if;
  if coalesce((p_config ->> 'maxRedeemPct')::int, -1) not between 0 and 100 then raise exception 'INVALID: max %% must be 0–100'; end if;
  if coalesce((p_config ->> 'minRedeem')::int, -1) < 0 then raise exception 'INVALID: minimum points'; end if;

  for m in select * from jsonb_array_elements(coalesce(p_config -> 'milestones', '[]'::jsonb)) loop
    if coalesce((m ->> 'orders')::int, 0) < 1 then raise exception 'INVALID: milestone order count must be at least 1'; end if;
    if coalesce(m ->> 'type', '') not in ('points', 'cashback', 'free_dish') then raise exception 'INVALID: milestone reward type'; end if;
    if m ->> 'type' = 'free_dish' and not exists (select 1 from public.variant_map where variant = m ->> 'variant' and is_meal) then
      raise exception 'INVALID: choose the free dish';
    end if;
    v_ms := v_ms || jsonb_build_array(jsonb_build_object(
      'id', coalesce(nullif(m ->> 'id', ''), substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
      'orders', (m ->> 'orders')::int,
      'repeat', coalesce((m ->> 'repeat')::boolean, false),
      'type', m ->> 'type',
      'points', greatest(coalesce((m ->> 'points')::int, 0), 0),
      'amount', greatest(coalesce((m ->> 'amount')::numeric, 0), 0),
      'variant', m ->> 'variant'));
  end loop;

  v_new := jsonb_build_object(
    'enabled', coalesce((p_config ->> 'enabled')::boolean, false),
    -- Orders placed before loyalty was first switched on never earn.
    'startedAt', coalesce(nullif(v_old ->> 'startedAt', ''),
                          case when coalesce((p_config ->> 'enabled')::boolean, false) then now()::text end),
    'earn', jsonb_build_object(
      'mode', v_mode,
      'pointsPerOrder', greatest(coalesce((p_config -> 'earn' ->> 'pointsPerOrder')::int, 0), 0),
      'pointsPerStep', greatest(coalesce((p_config -> 'earn' ->> 'pointsPerStep')::int, 0), 0),
      'rupeesStep', greatest(coalesce((p_config -> 'earn' ->> 'rupeesStep')::numeric, 1), 1)),
    'pointValue', (p_config ->> 'pointValue')::numeric,
    'minRedeem', (p_config ->> 'minRedeem')::int,
    'maxRedeemPct', (p_config ->> 'maxRedeemPct')::int,
    'milestones', v_ms);

  insert into public.cx_config (key, value, updated_at) values ('loyalty', v_new, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return v_new;
end $$;

create or replace function public.staff_loyalty_adjust(p_phone text, p_points int, p_note text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare v_phone text := cx.norm_phone(p_phone);
begin
  perform cx.require_staff();
  if v_phone is null or v_phone !~ '^\d{10}$' then raise exception 'INVALID: phone'; end if;
  if coalesce(p_points, 0) = 0 then raise exception 'INVALID: points'; end if;
  if p_points < 0 and cx.points_balance(array[v_phone]) + p_points < 0 then
    raise exception 'INVALID: balance would go below zero';
  end if;
  insert into public.loyalty_ledger (id, phone, points, kind, note, created_by)
  values ('adj:' || replace(gen_random_uuid()::text, '-', ''), v_phone, p_points, 'adjust',
          coalesce(nullif(trim(p_note), ''), 'Adjusted by Homely'), cx.staff_email());
  return jsonb_build_object('balance', cx.points_balance(array[v_phone]));
end $$;

create or replace function public.staff_loyalty_history(p_phone text)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
begin
  perform cx.require_staff();
  return jsonb_build_object(
    'history', coalesce((select jsonb_agg(to_jsonb(l) order by l.created_at desc)
                         from public.loyalty_ledger l where l.phone = p_phone), '[]'::jsonb),
    'vouchers', coalesce((select jsonb_agg(to_jsonb(v) order by v.issued_at desc)
                          from public.reward_vouchers v where v.phone = p_phone), '[]'::jsonb));
end $$;

create or replace function public.staff_voucher_set(p_id text, p_status text)
returns void
language plpgsql
security definer
set search_path to ''
as $$
begin
  perform cx.require_staff();
  if p_status not in ('available', 'used', 'void') then raise exception 'INVALID: status'; end if;
  update public.reward_vouchers
     set status = p_status, used_at = case when p_status = 'used' then coalesce(used_at, now()) else null end,
         used_order_id = case when p_status = 'used' then used_order_id else null end
   where id = p_id;
end $$;

do $$
declare f text;
begin
  foreach f in array array['cx.item_variant(text)', 'cx.loyalty_config()', 'cx.loyalty_group_key(text)', 'cx.phones_of(text)',
                           'cx.points_balance(text[])', 'cx.loyalty_award(public.orders)', 'cx.loyalty_reverse_award(public.orders)',
                           'cx.loyalty_refund_redemption(public.orders)', 'cx.trg_loyalty()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['public.my_rewards()', 'public.my_pref_form_link()', 'public.staff_loyalty_get()',
                           'public.staff_loyalty_save(jsonb)', 'public.staff_loyalty_adjust(text,int,text)',
                           'public.staff_loyalty_history(text)', 'public.staff_voucher_set(text,text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
