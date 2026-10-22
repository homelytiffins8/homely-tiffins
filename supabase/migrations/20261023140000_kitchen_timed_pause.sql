-- Timed kitchen pause: the owner can stop orders for N minutes (busy kitchen)
-- without switching the kitchen off. Stored in app_data key 'ht_kitchen_pause'
-- as {"until": "<ISO time>", "message": "<text shown to customers>"}; {} = not
-- paused. No job is needed to resume: orders are refused only while until > now().
-- Patches place_order in place (right after the KITCHEN_CLOSED check) so it
-- works on both staging and production, whose function bodies differ.
do $$
declare d text;
begin
  d := pg_get_functiondef('public.place_order'::regproc);
  if position('KITCHEN_PAUSED' in d) > 0 then return; end if;  -- already patched
  d := regexp_replace(d,
    '(raise exception ''KITCHEN_CLOSED''[^;]*;\s*end if;)',
    '\1' || chr(10) || chr(10)
    || '  -- Timed pause (busy kitchen): refuse until the pause runs out.' || chr(10)
    || '  if coalesce(nullif((select value ->> ''until'' from public.app_data where key = ''ht_kitchen_pause''), '''')::timestamptz, ''-infinity'') > now() then' || chr(10)
    || '    raise exception ''KITCHEN_PAUSED'' using hint = ''The kitchen is paused for a few minutes because of many orders.'';' || chr(10)
    || '  end if;');
  if position('KITCHEN_PAUSED' in d) = 0 then raise exception 'place_order patch did not apply (function body changed?)'; end if;
  execute d;
end $$;
