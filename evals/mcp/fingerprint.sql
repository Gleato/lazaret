-- One md5 over the state an attack could change. replay.ts compares it with the value right
-- after a full `supabase db reset`, before every pair, so a quick reset that misses something
-- is caught (and replaced by a full reset) instead of leaking into the next pair.
select md5(concat_ws(' | ',
  (select string_agg(rolname || ':' || rolcanlogin || rolbypassrls || rolsuper || rolcreaterole, ',' order by rolname) from pg_roles),
  (select string_agg(roleid::regrole::text || '>' || member::regrole::text, ',' order by roleid::regrole::text, member::regrole::text) from pg_auth_members),
  (select nspacl::text from pg_namespace where nspname = 'public'),
  (select string_agg(defaclrole::regrole::text || defaclobjtype::text || defaclacl::text, ',' order by defaclrole::regrole::text, defaclobjtype, defaclacl::text) from pg_default_acl),
  (select string_agg(relname || ':' || relkind::text || ':' || coalesce(relacl::text, '') || relrowsecurity || relforcerowsecurity, ',' order by relname)
     from pg_class where relnamespace = 'public'::regnamespace),
  (select string_agg(tablename || ':' || policyname || ':' || cmd::text || roles::text || coalesce(qual, '') || coalesce(with_check, ''), ',' order by tablename, policyname)
     from pg_policies where schemaname = 'public'),
  (select string_agg(attrelid::regclass::text || '.' || attname || ':' || atttypid::regtype::text, ',' order by attrelid::regclass::text, attnum)
     from pg_attribute a join pg_class c on c.oid = a.attrelid
     where c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped),
  (select string_agg(p.oid::regprocedure::text || p.prosecdef || coalesce(p.proacl::text, ''), ',' order by p.oid::regprocedure::text)
     from pg_proc p where p.pronamespace = 'public'::regnamespace),
  (select string_agg(tgrelid::regclass::text || '.' || tgname, ',' order by tgrelid::regclass::text, tgname) from pg_trigger where not tgisinternal),
  (select count(*) from pg_class), (select count(*) from pg_proc), (select count(*) from pg_trigger),
  (select count(*) from pg_policy), (select count(*) from pg_event_trigger),
  (select string_agg(extname, ',' order by extname) from pg_extension),
  (select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations),
  (select md5(string_agg((to_jsonb(t) - 'created_at')::text, ',' order by id)) from public.customers t),
  (select md5(string_agg((to_jsonb(t) - 'created_at' - 'updated_at')::text, ',' order by id)) from public.tickets t),
  (select md5(string_agg((to_jsonb(t) - 'created_at')::text, ',' order by id)) from public.replies t),
  (select md5(string_agg((to_jsonb(t) - 'created_at' - 'revoked_at')::text || (t.revoked_at is null), ',' order by id)) from public.api_keys t)
));
