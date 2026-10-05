-- ROLLBACK for customer_profiles_001 … 005 (Customer Profiles, Preferences & Reactivation).
-- Run in the Supabase SQL editor for the STAGING project. Existing tables (orders, customers,
-- credit_ledger, app_data, …) are never altered by these migrations, apart from the triggers
-- below, so rolling back only removes the new feature. WARNING: this permanently deletes
-- everything captured by the feature (confirmed preferences, consent log, contact log,
-- feedback, notes, order snapshots, merge audit). Export first if you need it.

-- 1. stop the daily refresh
do $$ begin perform cron.unschedule('cx-refresh-all-daily'); exception when others then null; end $$;

-- 2. remove triggers on existing tables
drop trigger if exists cx_orders_ins on public.orders;
drop trigger if exists cx_orders_upd on public.orders;
drop trigger if exists cx_orders_del on public.orders;
drop trigger if exists cx_plan_config on public.app_data;

-- 3. customer-facing and staff RPCs
drop function if exists public.pref_form_token_for_order(text);
drop function if exists public.pref_form_get(text);
drop function if exists public.pref_form_save(text, jsonb, text);
drop function if exists public.pref_form_skip(text);
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'staff\_%' loop
    execute format('drop function if exists %s', f.sig);
  end loop;
end $$;

-- 4. views and tables (children first; CASCADE handles the remaining foreign keys)
drop view if exists public.customer_prefs_current, public.customer_consent_current;
drop table if exists
  public.preference_form_submissions, public.preference_form_tokens, public.contact_log,
  public.marketing_consent_log, public.customer_internal_notes, public.customer_feedback,
  public.customer_pref_log, public.analysis_runs, public.analysis_errors, public.customer_dish_stats,
  public.customer_analysis, public.order_snapshot_audit, public.order_snapshot_components,
  public.order_snapshot_lines, public.order_snapshots, public.menu_publication_dishes,
  public.menu_publications, public.dish_aliases, public.dish_catalog, public.customer_merge_audit,
  public.duplicate_dismissals, public.customer_identities, public.variant_map, public.cx_config
  cascade;

-- 5. private helper schema and the staff check
drop schema if exists cx cascade;
drop function if exists public.is_staff();

-- 6. (optional) pg_cron was enabled by migration 003; drop it only if nothing else uses it
-- drop extension if exists pg_cron;

-- 7. forget the migrations in the history table so a re-apply is possible
delete from supabase_migrations.schema_migrations where name like 'customer_profiles\_%';
