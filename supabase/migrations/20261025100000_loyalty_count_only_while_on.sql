-- Loyalty: orders delivered while the programme is switched off don't count
-- toward milestones (owner's request, 2026-10-25).
--
-- An order counts once it is marked delivered while loyalty is on (and was
-- placed after loyalty first started). That moment is recorded in
-- loyalty_counted_orders. If the order later leaves "delivered", the mark is
-- removed, so a re-delivery while loyalty is off doesn't count either.
-- The minimum order value is still applied when counting, as before.

create table if not exists public.loyalty_counted_orders (
  order_id text primary key references public.orders(id) on delete cascade,
  counted_at timestamptz not null default now()
);
alter table public.loyalty_counted_orders enable row level security;
drop policy if exists loyalty_counted_orders_staff_read on public.loyalty_counted_orders;
create policy loyalty_counted_orders_staff_read on public.loyalty_counted_orders
  for select to authenticated using ((select public.is_staff()));

-- Off periods weren't recorded before this, so every order delivered since
-- loyalty first started keeps counting.
insert into public.loyalty_counted_orders (order_id)
select o.id
from public.orders o
cross join (select value from public.cx_config where key = 'loyalty') c
where o.status = 'delivered'
  and nullif(c.value ->> 'startedAt', '') is not null
  and o.created_at >= (c.value ->> 'startedAt')::timestamptz
on conflict (order_id) do nothing;

-- Milestone progress: counted, still-delivered orders at or above the minimum.
create or replace function cx.loyalty_count(p_phones text[], p_cfg jsonb)
returns int
language sql
stable
security definer
set search_path to ''
as $$
  select count(*)::int
  from public.orders o
  join public.loyalty_counted_orders c on c.order_id = o.id
  where o.phone = any(p_phones) and o.status = 'delivered'
    and (nullif(p_cfg ->> 'startedAt', '') is null or o.created_at >= (p_cfg ->> 'startedAt')::timestamptz)
    and (coalesce((p_cfg ->> 'minOrder')::numeric, 0) <= 0
         or coalesce((o.extra ->> 'originalTotal')::numeric, o.total) >= (p_cfg ->> 'minOrder')::numeric)
$$;
revoke all on function cx.loyalty_count(text[], jsonb) from public, anon, authenticated;

-- ── Award: mark the order as counted (loyalty is on), then count ──
create or replace function cx.loyalty_award(o public.orders)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_cfg jsonb := cx.loyalty_config();
  v_start timestamptz;
  v_min numeric;
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
  v_base text;
  v_tries int;
  v_label text;
begin
  if v_cfg is null or not coalesce((v_cfg ->> 'enabled')::boolean, false) then return; end if;
  v_start := nullif(v_cfg ->> 'startedAt', '')::timestamptz;
  if v_start is not null and o.created_at < v_start then return; end if;
  -- Delivered while loyalty is on: this order counts toward milestones.
  insert into public.loyalty_counted_orders (order_id) values (o.id) on conflict (order_id) do nothing;
  v_min := coalesce((v_cfg ->> 'minOrder')::numeric, 0);
  if v_min > 0 and coalesce((o.extra ->> 'originalTotal')::numeric, o.total) < v_min then return; end if;

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

  -- Milestones: fire when the count lands on a multiple.
  v_phones := cx.phones_of(o.phone);
  v_group := cx.loyalty_group_key(o.phone);
  v_n := cx.loyalty_count(v_phones, v_cfg);

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
    -- One award per (rule, customer, k). Earlier attempts that were reversed
    -- (order left "delivered") don't count, so the reward can be given again.
    v_base := format('ms:%s:%s:%s', m ->> 'id', v_group, v_k);
    v_label := format('%s-order reward', v_every);

    if m ->> 'type' = 'points' and coalesce((m ->> 'points')::int, 0) > 0 then
      if not exists (select 1 from public.loyalty_ledger l
                     where (l.id = v_base or l.id like v_base || ':r%')
                       and not exists (select 1 from public.loyalty_ledger x where x.id = 'rev:' || l.id)) then
        select count(*) into v_tries from public.loyalty_ledger where id = v_base or id like v_base || ':r%';
        v_id := v_base || case when v_tries > 0 then ':r' || v_tries else '' end;
        insert into public.loyalty_ledger (id, phone, points, kind, order_id, note)
        values (v_id, o.phone, (m ->> 'points')::int, 'milestone', o.id, v_label)
        on conflict (id) do nothing;
      end if;
    elsif m ->> 'type' = 'cashback' and coalesce((m ->> 'amount')::numeric, 0) > 0 then
      -- A reversal deletes the cashback row, so the same id can be used again.
      insert into public.credit_ledger (id, phone, order_id, amount, type, note, created_at, extra)
      values ('loy:' || v_base, o.phone, o.id, (m ->> 'amount')::numeric, 'credit',
              'Loyalty cashback — ' || v_label, now(), jsonb_build_object('loyaltyRule', m ->> 'id'))
      on conflict (id) do nothing;
    elsif m ->> 'type' = 'free_dish' and coalesce(m ->> 'variant', '') <> '' then
      if not exists (select 1 from public.reward_vouchers
                     where (id = v_base or id like v_base || ':r%') and status <> 'void') then
        select count(*) into v_tries from public.reward_vouchers where id = v_base or id like v_base || ':r%';
        v_id := v_base || case when v_tries > 0 then ':r' || v_tries else '' end;
        insert into public.reward_vouchers (id, phone, rule_id, variant, label, issued_order_id)
        values (v_id, o.phone, m ->> 'id', m ->> 'variant',
                'Free ' || coalesce((select label from public.variant_map where variant = m ->> 'variant'), m ->> 'variant'),
                o.id)
        on conflict (id) do nothing;
      end if;
    end if;
  end loop;
end $$;

-- ── Order left "delivered": un-count it, take back its points, keep a
--    milestone the customer still qualifies for ──
create or replace function cx.loyalty_reverse_award(o public.orders)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  l record;
  v_cfg jsonb := cx.loyalty_config();
  v_n int;
begin
  delete from public.loyalty_counted_orders where order_id = o.id;
  v_n := cx.loyalty_count(cx.phones_of(o.phone), v_cfg);

  for l in select * from public.loyalty_ledger
           where order_id = o.id and kind in ('earn', 'milestone')
             and not exists (select 1 from public.loyalty_ledger r where r.id = 'rev:' || loyalty_ledger.id)
  loop
    continue when l.kind = 'milestone' and cx.loyalty_ms_met(l.id, v_cfg, v_n);
    insert into public.loyalty_ledger (id, phone, points, kind, order_id, note)
    values ('rev:' || l.id, l.phone, -l.points, 'reversal', o.id, 'Reversed — order not delivered')
    on conflict (id) do nothing;
  end loop;
  update public.reward_vouchers set status = 'void'
  where issued_order_id = o.id and status = 'available' and not cx.loyalty_ms_met(id, v_cfg, v_n);
  delete from public.credit_ledger
  where id like 'loy:%' and order_id = o.id and not cx.loyalty_ms_met(substr(id, 5), v_cfg, v_n);
end $$;

-- ── My Homely progress ("N more orders to …") uses the same count ──
do $$
declare
  v_def text := pg_get_functiondef('public.my_rewards()'::regprocedure);
  v_old text := '  select count(*) into v_n from public.orders
  where phone = any(v_phones) and status = ''delivered'' and (v_start is null or created_at >= v_start)
    and (v_min <= 0 or coalesce((extra ->> ''originalTotal'')::numeric, total) >= v_min);';
begin
  if position(v_old in v_def) = 0 then raise exception 'my_rewards: expected count query not found'; end if;
  execute replace(v_def, v_old, '  v_n := cx.loyalty_count(v_phones, v_cfg);');
end $$;
