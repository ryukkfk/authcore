-- Explicit operator provisioning after recovery migration. Never API startup.
DO $recovery_requester$
DECLARE
  role_name text := current_setting('authcore.recovery_role',true);
  principal record;
  relation record;
  col record;
  readable boolean;
  insertable boolean;
  updatable boolean;
BEGIN
  IF role_name IS NULL OR role_name !~ '^authcore_recovery_requester_[a-z0-9_]{1,32}$' THEN
    RAISE EXCEPTION 'Invalid recovery requester principal';
  END IF;
  SELECT * INTO principal FROM pg_catalog.pg_roles WHERE rolname=role_name;
  IF NOT FOUND OR NOT principal.rolcanlogin OR principal.rolsuper OR principal.rolcreatedb
    OR principal.rolcreaterole OR principal.rolreplication OR principal.rolbypassrls
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=principal.oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba=principal.oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=principal.oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=principal.oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE proowner=principal.oid) THEN
    RAISE EXCEPTION 'Recovery requester must be an unprivileged login without ownership or memberships';
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
  -- updated_at UPDATE is solely the minimum column authority needed for account
  -- FOR UPDATE ownership. This requester has no password/session/status mutation.
  EXECUTE format('GRANT SELECT(id,email_normalized,email_verified_at,disabled_at),UPDATE(updated_at) ON public.users TO %I',role_name);
  EXECUTE format('GRANT SELECT(user_id,password_hash) ON public.password_credentials TO %I',role_name);
  EXECUTE format('GRANT SELECT(id,user_id,created_at),INSERT(user_id,credential_binding,email_binding,request_id,created_at,expires_at) ON public.password_recovery_requests TO %I',role_name);
  EXECUTE format('GRANT INSERT(event_id) ON public.password_recovery_deliveries TO %I',role_name);
  FOR relation IN SELECT c.oid,c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') LOOP
    IF has_table_privilege(role_name,relation.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN,SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION') THEN
      RAISE EXCEPTION 'Unsafe recovery requester table privileges';
    END IF;
    FOR col IN SELECT attname FROM pg_catalog.pg_attribute WHERE attrelid=relation.oid AND attnum>0 AND NOT attisdropped LOOP
      readable := (relation.relname='users' AND col.attname IN ('id','email_normalized','email_verified_at','disabled_at'))
        OR (relation.relname='password_credentials' AND col.attname IN ('user_id','password_hash'))
        OR (relation.relname='password_recovery_requests' AND col.attname IN ('id','user_id','created_at'));
      insertable := (relation.relname='password_recovery_requests' AND col.attname IN ('user_id','credential_binding','email_binding','request_id','created_at','expires_at'))
        OR (relation.relname='password_recovery_deliveries' AND col.attname='event_id');
      updatable := relation.relname='users' AND col.attname='updated_at';
      IF has_column_privilege(role_name,relation.oid,col.attname,'SELECT') IS DISTINCT FROM readable
        OR has_column_privilege(role_name,relation.oid,col.attname,'INSERT') IS DISTINCT FROM insertable
        OR has_column_privilege(role_name,relation.oid,col.attname,'UPDATE') IS DISTINCT FROM updatable
        OR has_column_privilege(role_name,relation.oid,col.attname,'REFERENCES,SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION') THEN
        RAISE EXCEPTION 'Unsafe recovery requester column privileges';
      END IF;
    END LOOP;
  END LOOP;
  IF has_database_privilege(role_name,current_database(),'CREATE,TEMPORARY')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema' AND has_schema_privilege(role_name,oid,'CREATE'))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.prosecdef AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_function_privilege(role_name,p.oid,'EXECUTE'))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_parameter_acl WHERE has_parameter_privilege(role_name,parname,'SET,ALTER SYSTEM'))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname<>'public' AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
      AND c.relkind IN ('r','p','v','m','f') AND (has_table_privilege(role_name,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        OR has_any_column_privilege(role_name,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE CASE WHEN c.relkind='S' THEN has_sequence_privilege(role_name,c.oid,'SELECT,USAGE,UPDATE') ELSE false END)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p,LATERAL pg_catalog.aclexplode(p.proacl) a WHERE a.grantee=principal.oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace,
      LATERAL pg_catalog.aclexplode(c.relacl) a WHERE n.nspname<>'public' AND a.grantee=principal.oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute attribute_acl JOIN pg_catalog.pg_class c ON c.oid=attribute_acl.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace,
      LATERAL pg_catalog.aclexplode(attribute_acl.attacl) a WHERE n.nspname<>'public' AND a.grantee=principal.oid) THEN
    RAISE EXCEPTION 'Unsafe recovery requester authority outside its boundary';
  END IF;
END
$recovery_requester$;
