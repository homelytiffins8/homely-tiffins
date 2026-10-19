-- Referral codes at checkout: check them on the server.
--
-- The checkout form used to look the referrer up in the `customers` list in
-- the browser. Visitors can't read that table (RLS), so every referral code
-- showed "not recognised" for guests. This applies the same rules as
-- place_order and returns only what the form needs: valid or not, the reason,
-- the discount and the referrer's first name (never their phone).
create or replace function public.check_referral_code(p_code text, p_phone text)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_cfg jsonb := (select value from public.app_data where key = 'ht_referral_config');
  v_code text := upper(trim(coalesce(p_code, '')));
  v_phone text := trim(coalesce(p_phone, ''));
  v_name text;
begin
  if v_cfg is null or not coalesce((v_cfg ->> 'enabled')::boolean, true) then
    return jsonb_build_object('ok', false, 'error', 'Referral codes aren''t active right now');
  end if;
  if v_code !~ '^HT[0-9]{8}$' then
    return jsonb_build_object('ok', false, 'error', 'Referral code not recognised');
  end if;
  if v_phone !~ '^\d{10}$' then
    return jsonb_build_object('ok', false, 'error', 'Enter your phone number to use a referral code');
  end if;
  if 'HT' || right(v_phone, 8) = v_code then
    return jsonb_build_object('ok', false, 'error', 'You can''t use your own referral code');
  end if;

  select c.name into v_name from public.customers c
  where 'HT' || right(regexp_replace(c.phone, '\D', '', 'g'), 8) = v_code
    and coalesce(c.total_orders, 0) >= 1
  limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Referral code not recognised');
  end if;

  if exists (select 1 from public.orders where phone = v_phone) then
    return jsonb_build_object('ok', false, 'error', 'Referral codes are only for new customers');
  end if;

  return jsonb_build_object(
    'ok', true,
    'referrerName', split_part(trim(coalesce(v_name, '')), ' ', 1),
    'referredDiscount', greatest(coalesce((v_cfg ->> 'referredDiscount')::numeric, 0), 0),
    'minOrder', coalesce((v_cfg ->> 'minOrder')::numeric, 0));
end $$;

revoke all on function public.check_referral_code(text, text) from public;
grant execute on function public.check_referral_code(text, text) to anon, authenticated;
