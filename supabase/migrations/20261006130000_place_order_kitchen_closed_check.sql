-- place_order must refuse orders while the owner has the kitchen marked CLOSED.
-- Previously only the customer's screen checked this, so a stale screen (missed
-- realtime update) could still place an order. Patches the existing function in
-- place so it works on both staging and production (identical function bodies).
do $$
declare d text;
begin
  d := pg_get_functiondef('public.place_order'::regproc);
  if position('KITCHEN_CLOSED' in d) > 0 then return; end if;  -- already patched
  d := replace(d,
    E'begin\n  v_phone := coalesce(p_order->>''phone'', '''');',
    E'begin\n  -- Kitchen closed => reject (server-side; the client check alone can be stale).\n'
    || E'  if coalesce((select value #>> ''{}'' from public.app_data where key = ''ht_kitchen_open''), ''true'') = ''false'' then\n'
    || E'    raise exception ''KITCHEN_CLOSED'' using hint = ''The kitchen is closed and not accepting orders right now.'';\n'
    || E'  end if;\n\n  v_phone := coalesce(p_order->>''phone'', '''');');
  if position('KITCHEN_CLOSED' in d) = 0 then raise exception 'place_order patch did not apply (function body changed?)'; end if;
  execute d;
end $$;
