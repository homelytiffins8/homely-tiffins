-- Is the loyalty programme switched on? Readable by guests, so checkout can
-- hide the "Sign in to use your Homely Points" box while loyalty is off.
-- Returns only the on/off flag — none of the rest of the loyalty config.

create or replace function public.loyalty_enabled()
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce((select (value ->> 'enabled')::boolean from public.cx_config where key = 'loyalty'), false)
$$;

revoke all on function public.loyalty_enabled() from public;
grant execute on function public.loyalty_enabled() to anon, authenticated;
