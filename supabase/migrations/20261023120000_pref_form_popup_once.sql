-- Food-preferences popup opens only once per customer.
-- Adds 'asked': true once the customer has saved OR skipped the form (any submission row),
-- so the app stops auto-opening it after a skip. The order-page card and My Homely link stay.
-- Also records order_no (this order's number for the phone, rejected orders excluded),
-- which the live function already returned but no earlier migration file had.
create or replace function public.pref_form_status_for_order(p_order_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare o record; v_id uuid; v_root uuid; v_done boolean := false; v_asked boolean := false; v_no int;
begin
  select id, phone, created_at into o from public.orders where id = p_order_id;
  if not found or o.created_at < now() - interval '30 days' then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  select count(*) into v_no from public.orders x
    where x.phone = o.phone and x.status <> 'rejected' and x.created_at <= o.created_at;
  select id into v_id from public.customer_identities where phone_raw = o.phone;
  if v_id is null then
    return jsonb_build_object('ok', true, 'completed', false, 'asked', false, 'order_no', v_no);
  end if;
  v_root := cx.root_of(v_id);
  select coalesce(bool_or(not s.skipped), false), count(*) > 0 into v_done, v_asked
    from public.preference_form_submissions s
    where s.customer_id in (v_id, v_root);
  return jsonb_build_object('ok', true, 'completed', v_done, 'asked', v_asked, 'order_no', v_no);
end $function$;

revoke all on function public.pref_form_status_for_order(text) from public;
grant execute on function public.pref_form_status_for_order(text) to anon, authenticated, service_role;
