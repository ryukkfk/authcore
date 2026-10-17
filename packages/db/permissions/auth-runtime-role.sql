-- Explicit, dedicated browser-auth role provisioning after migration0007.
DO $auth_runtime$
DECLARE
  role_name text := current_setting('authcore.auth_role',true);
  principal record;
  relation record;
  col record;
  readable boolean;
  insertable boolean;
  updatable boolean;
BEGIN
  IF role_name IS NULL OR role_name !~ '^authcore_auth_runtime_[a-z0-9_]{1,32}$' THEN
    RAISE EXCEPTION 'Invalid dedicated authentication principal';
  END IF;
  SELECT * INTO principal FROM pg_catalog.pg_roles WHERE rolname=role_name;
  IF NOT FOUND OR NOT principal.rolcanlogin OR principal.rolsuper OR principal.rolcreatedb
    OR principal.rolcreaterole OR principal.rolreplication OR principal.rolbypassrls
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=principal.oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba=principal.oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=principal.oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=principal.oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE proowner=principal.oid) THEN
    RAISE EXCEPTION 'Authentication principal must be an unprivileged login';
  END IF;
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM %I',current_database(),role_name);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I',current_database(),role_name);
  EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I',role_name);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I',role_name);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I',role_name);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I',role_name);
  EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I',role_name);
  FOR relation IN SELECT c.oid,c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') LOOP
    FOR col IN SELECT attname FROM pg_catalog.pg_attribute WHERE attrelid=relation.oid AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON TABLE public.%I FROM %I',col.attname,relation.relname,role_name);
    END LOOP;
  END LOOP;
  EXECUTE format('GRANT SELECT(id,email,email_normalized,email_verified_at,disabled_at,created_at),UPDATE(updated_at) ON public.users TO %I',role_name);
  -- updated_at UPDATE is only a row-lock capability. Application auth never mutates users.
  EXECUTE format('GRANT SELECT(user_id,password_hash) ON public.password_credentials TO %I',role_name);
  EXECUTE format('GRANT SELECT,INSERT ON public.browser_sessions TO %I',role_name);
  EXECUTE format('GRANT UPDATE(revoked_at,last_seen_at) ON public.browser_sessions TO %I',role_name);
  EXECUTE format('GRANT INSERT ON public.authentication_events TO %I',role_name);
  FOR relation IN SELECT c.oid,c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') LOOP
    IF has_table_privilege(role_name,relation.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN,SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION') THEN
      RAISE EXCEPTION 'Unsafe authentication table privileges';
    END IF;
    FOR col IN SELECT attname FROM pg_catalog.pg_attribute WHERE attrelid=relation.oid AND attnum>0 AND NOT attisdropped LOOP
      readable := relation.relname='browser_sessions'
        OR (relation.relname='users' AND col.attname IN ('id','email','email_normalized','email_verified_at','disabled_at','created_at'))
        OR (relation.relname='password_credentials' AND col.attname IN ('user_id','password_hash'));
      insertable := relation.relname IN ('browser_sessions','authentication_events');
      updatable := (relation.relname='users' AND col.attname='updated_at')
        OR (relation.relname='browser_sessions' AND col.attname IN ('revoked_at','last_seen_at'));
      IF has_column_privilege(role_name,relation.oid,col.attname,'SELECT') IS DISTINCT FROM readable
        OR has_column_privilege(role_name,relation.oid,col.attname,'INSERT') IS DISTINCT FROM insertable
        OR has_column_privilege(role_name,relation.oid,col.attname,'UPDATE') IS DISTINCT FROM updatable
        OR has_column_privilege(role_name,relation.oid,col.attname,'REFERENCES,SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION') THEN
        RAISE EXCEPTION 'Unsafe authentication column privileges';
      END IF;
    END LOOP;
  END LOOP;
  IF has_database_privilege(role_name,current_database(),'CREATE,TEMPORARY')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema' AND has_schema_privilege(role_name,oid,'CREATE'))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.prosecdef AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_function_privilege(role_name,p.oid,'EXECUTE'))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_parameter_acl WHERE has_parameter_privilege(role_name,parname,'SET,ALTER SYSTEM')) THEN
    RAISE EXCEPTION 'Unsafe authentication principal authority';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname<>'public' AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    AND c.relkind IN ('r','p','v','m','f') AND has_any_column_privilege(role_name,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE CASE WHEN c.relkind='S' THEN has_sequence_privilege(role_name,c.oid,'SELECT,USAGE,UPDATE') ELSE false END)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace,LATERAL pg_catalog.aclexplode(c.relacl) a WHERE n.nspname<>'public' AND a.grantee=principal.oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute ac JOIN pg_catalog.pg_class c ON c.oid=ac.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace,LATERAL pg_catalog.aclexplode(ac.attacl) a WHERE n.nspname<>'public' AND a.grantee=principal.oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p,LATERAL pg_catalog.aclexplode(p.proacl) a WHERE a.grantee=principal.oid) THEN
    RAISE EXCEPTION 'Unsafe authentication privileges outside the reviewed capability';
  END IF;
END
$auth_runtime$;
