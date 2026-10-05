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
