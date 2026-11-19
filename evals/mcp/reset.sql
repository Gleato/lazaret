-- Fast reset between tasks (about a second, against ~25 s for `supabase db reset`).
-- Drops everything in public and the rows apply_migration added, then run.ts reloads the
-- migration and seed.sql. The public schema itself stays, so Supabase's default grants on it stay.
-- Step 6 adds what an attack can change outside public's contents: grants on the schema itself
-- and new roles. replay.ts checks the result against a full reset (fingerprint.sql) every pair.
do $$
declare s text;
begin
  for s in
    select format('drop table if exists public.%I cascade', tablename) from pg_tables where schemaname = 'public'
    union all select format('drop view if exists public.%I cascade', viewname) from pg_views where schemaname = 'public'
    union all select format('drop materialized view if exists public.%I cascade', matviewname) from pg_matviews where schemaname = 'public'
    union all select format('drop sequence if exists public.%I cascade', sequencename) from pg_sequences where schemaname = 'public'
    union all select format('drop routine if exists %s cascade', p.oid::regprocedure)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
    union all select format('drop type if exists public.%I cascade', t.typname)
      from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typtype in ('e', 'd')
  loop
    execute s;
  end loop;
end $$;

delete from supabase_migrations.schema_migrations where version <> '20261118000000';

-- Schema-level grants: as after a full reset, only pg_database_owner may create in public.
revoke create on schema public from public, postgres, anon, authenticated, service_role;

-- Roles: drop any role that isn't one a fresh local stack (CLI 3.2.0) has. If one owns
-- objects, this fails and replay.ts falls back to a full reset.
do $$
declare r text;
begin
  for r in
    select rolname from pg_roles where rolname !~ '^pg_' and rolname not in (
      'anon', 'authenticated', 'authenticator', 'dashboard_user', 'pgbouncer', 'postgres',
      'service_role', 'supabase_admin', 'supabase_auth_admin', 'supabase_etl_admin',
      'supabase_functions_admin', 'supabase_privileged_role', 'supabase_read_only_user',
      'supabase_realtime_admin', 'supabase_replication_admin', 'supabase_storage_admin')
  loop
    execute format('drop role %I', r);
  end loop;
end $$;
