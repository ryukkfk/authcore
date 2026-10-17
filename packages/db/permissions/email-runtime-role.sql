-- Explicit operator provisioning after migration0006; never API startup.
DO $email_runtime$
DECLARE
  role_name text := current_setting('authcore.email_role', true);
  capability text := current_setting('authcore.email_capability', true);
  principal record;
  relation record;
  col record;
  readable boolean;
  insertable boolean;
  updatable boolean;
BEGIN
  IF capability NOT IN ('worker','verification') OR capability IS NULL OR role_name IS NULL
      OR role_name !~ '^authcore_email_(worker|verifier)_[a-z0-9_]{1,32}$'
      OR (capability='worker' AND role_name NOT LIKE 'authcore_email_worker_%')
      OR (capability='verification' AND role_name NOT LIKE 'authcore_email_verifier_%') THEN
    RAISE EXCEPTION 'Invalid dedicated email principal';
  END IF;
  SELECT * INTO principal FROM pg_catalog.pg_roles WHERE rolname=role_name;
  IF NOT FOUND OR NOT principal.rolcanlogin OR principal.rolsuper OR principal.rolcreatedb
      OR principal.rolcreaterole OR principal.rolreplication OR principal.rolbypassrls
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=principal.oid)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba=principal.oid)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=principal.oid)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=principal.oid)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE proowner=principal.oid) THEN
    RAISE EXCEPTION 'Email principal must be an unprivileged login without memberships or ownership';
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
  IF capability='worker' THEN
    EXECUTE format('GRANT SELECT(id,email,email_verified_at,disabled_at) ON public.users TO %I',role_name);
    EXECUTE format('GRANT SELECT ON public.verification_events,public.email_deliveries,public.email_delivery_attempts TO %I',role_name);
    EXECUTE format('GRANT INSERT ON public.email_deliveries,public.email_verification_tokens,public.email_delivery_attempts TO %I',role_name);
    EXECUTE format('GRANT SELECT(event_id,expires_at) ON public.email_verification_tokens TO %I',role_name);
    EXECUTE format('GRANT UPDATE(status,attempts,next_attempt_at,owner,locked_until,envelope,updated_at) ON public.email_deliveries TO %I',role_name);
  ELSE
    EXECUTE format('GRANT SELECT(id,email_normalized,email_verified_at,disabled_at),UPDATE(email_verified_at,updated_at) ON public.users TO %I',role_name);
    EXECUTE format('GRANT SELECT(id,user_id,reason,created_at),INSERT(user_id,reason,request_id,created_at) ON public.verification_events TO %I',role_name);
    EXECUTE format('GRANT SELECT(event_id,digest,expires_at,consumed_at),UPDATE(consumed_at) ON public.email_verification_tokens TO %I',role_name);
    EXECUTE format('GRANT INSERT ON public.account_security_events TO %I',role_name);
  END IF;
  -- Reconcile every effective column, including PUBLIC grants.
  FOR relation IN SELECT c.oid,c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') LOOP
    IF has_table_privilege(role_name,relation.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN,SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION') THEN
      RAISE EXCEPTION 'Unsafe email table privileges';
    END IF;
    FOR col IN SELECT attname FROM pg_catalog.pg_attribute WHERE attrelid=relation.oid AND attnum>0 AND NOT attisdropped LOOP
      IF capability='worker' THEN
        readable := relation.relname IN ('verification_events','email_deliveries','email_delivery_attempts')
          OR (relation.relname='users' AND col.attname IN ('id','email','email_verified_at','disabled_at'))
          OR (relation.relname='email_verification_tokens' AND col.attname IN ('event_id','expires_at'));
        insertable := relation.relname IN ('email_deliveries','email_verification_tokens','email_delivery_attempts');
        updatable := relation.relname='email_deliveries' AND col.attname IN ('status','attempts','next_attempt_at','owner','locked_until','envelope','updated_at');
      ELSE
        readable := (relation.relname='users' AND col.attname IN ('id','email_normalized','email_verified_at','disabled_at'))
          OR (relation.relname='verification_events' AND col.attname IN ('id','user_id','reason','created_at'))
          OR (relation.relname='email_verification_tokens' AND col.attname IN ('event_id','digest','expires_at','consumed_at'));
        insertable := relation.relname='account_security_events'
          OR (relation.relname='verification_events' AND col.attname IN ('user_id','reason','request_id','created_at'));
        updatable := (relation.relname='users' AND col.attname IN ('email_verified_at','updated_at'))
          OR (relation.relname='email_verification_tokens' AND col.attname='consumed_at');
      END IF;
      IF has_column_privilege(role_name,relation.oid,col.attname,'SELECT') IS DISTINCT FROM readable
        OR has_column_privilege(role_name,relation.oid,col.attname,'INSERT') IS DISTINCT FROM insertable
        OR has_column_privilege(role_name,relation.oid,col.attname,'UPDATE') IS DISTINCT FROM updatable
        OR has_column_privilege(role_name,relation.oid,col.attname,'REFERENCES,SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION') THEN
        RAISE EXCEPTION 'Unsafe email column privileges';
      END IF;
    END LOOP;
  END LOOP;
  IF has_database_privilege(role_name,current_database(),'CREATE,TEMPORARY')
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema' AND has_schema_privilege(role_name,oid,'CREATE'))
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.prosecdef AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_function_privilege(role_name,p.oid,'EXECUTE'))
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_parameter_acl WHERE has_parameter_privilege(role_name,parname,'SET,ALTER SYSTEM')) THEN
    RAISE EXCEPTION 'Unsafe email principal authority';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname<>'public' AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
      AND c.relkind IN ('r','p','v','m','f') AND has_any_column_privilege(role_name,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')) THEN
    RAISE EXCEPTION 'Unsafe email privileges outside public schema';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE CASE WHEN c.relkind='S' THEN has_sequence_privilege(role_name,c.oid,'SELECT,USAGE,UPDATE') ELSE false END)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace,
      LATERAL pg_catalog.aclexplode(c.relacl) a WHERE n.nspname<>'public' AND a.grantee=principal.oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute attribute_acl JOIN pg_catalog.pg_class c ON c.oid=attribute_acl.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace,
      LATERAL pg_catalog.aclexplode(attribute_acl.attacl) a WHERE n.nspname<>'public' AND a.grantee=principal.oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p,LATERAL pg_catalog.aclexplode(p.proacl) a WHERE a.grantee=principal.oid) THEN
    RAISE EXCEPTION 'Unsafe explicit email principal privileges';
  END IF;
END
$email_runtime$;
