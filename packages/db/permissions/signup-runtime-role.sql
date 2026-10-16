-- Explicit operator action after migrations; never part of API startup.
-- See SIGNUP_RUNTIME_PERMISSIONS.md and provision-signup-runtime.psql.
-- The DO statement is atomic; failures roll back its grants/revocations.
DO $authcore_runtime$
DECLARE
  runtime_name text := pg_catalog.current_setting('authcore.runtime_role', true);
  runtime_role record;
  relation_name text;
  relation_oid oid;
  all_columns text;
  column_info record;
BEGIN
  IF runtime_name IS NULL OR runtime_name !~ '^[a-z_][a-z0-9_]{0,62}$'
      OR runtime_name LIKE 'pg\_%' ESCAPE '\' THEN
    RAISE EXCEPTION 'Invalid runtime role name';
  END IF;

  SELECT * INTO runtime_role FROM pg_catalog.pg_roles WHERE rolname = runtime_name;
  IF NOT FOUND OR NOT runtime_role.rolcanlogin OR runtime_role.rolsuper
      OR runtime_role.rolcreatedb OR runtime_role.rolcreaterole
      OR runtime_role.rolreplication OR runtime_role.rolbypassrls THEN
    RAISE EXCEPTION 'Runtime role must be an unprivileged login';
  END IF;
  -- Reject even NOINHERIT memberships: SET ROLE can still grant access.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = runtime_role.oid) THEN
    RAISE EXCEPTION 'Runtime role must have no role memberships';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datdba = runtime_role.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner = runtime_role.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relowner = runtime_role.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proowner = runtime_role.oid) THEN
    RAISE EXCEPTION 'Runtime role must not own database objects';
  END IF;

  -- Replace only this dedicated principal's direct grants on current signup
  -- objects. Never alter PUBLIC, other roles, default grants or role attributes.
  EXECUTE pg_catalog.format('REVOKE ALL ON DATABASE %I FROM %I', pg_catalog.current_database(), runtime_name);
  EXECUTE pg_catalog.format('GRANT CONNECT ON DATABASE %I TO %I', pg_catalog.current_database(), runtime_name);
  EXECUTE pg_catalog.format('REVOKE ALL ON SCHEMA public FROM %I', runtime_name);
  EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA public TO %I', runtime_name);

  FOREACH relation_name IN ARRAY ARRAY['users', 'password_credentials', 'security_audit_events',
      'signup_idempotency_claims', 'signup_idempotency_results',
      'signup_idempotency_namespace', 'signup_idempotency_terminal_events', 'verification_events'] LOOP
    relation_oid := pg_catalog.to_regclass(pg_catalog.format('public.%I', relation_name));
    IF relation_oid IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class WHERE oid = relation_oid AND relkind = 'r'
    ) THEN
      RAISE EXCEPTION 'Apply signup schema migrations before permission provisioning';
    END IF;
    SELECT pg_catalog.string_agg(pg_catalog.quote_ident(attname), ', ' ORDER BY attnum)
      INTO all_columns FROM pg_catalog.pg_attribute
      WHERE attrelid = relation_oid AND attnum > 0 AND NOT attisdropped;
    EXECUTE pg_catalog.format('REVOKE ALL ON TABLE public.%I FROM %I', relation_name, runtime_name);
    -- Table REVOKE alone does not remove independent column ACLs.
    EXECUTE pg_catalog.format('REVOKE ALL (%s) ON TABLE public.%I FROM %I', all_columns, relation_name, runtime_name);
    -- Drizzle explicitly lists all columns, including DEFAULT expressions.
    -- PostgreSQL requires INSERT on those defaulted columns too.
    EXECUTE pg_catalog.format('GRANT SELECT ON TABLE public.%I TO %I', relation_name, runtime_name);
    IF relation_name <> 'signup_idempotency_namespace' THEN
      EXECUTE pg_catalog.format('GRANT INSERT ON TABLE public.%I TO %I', relation_name, runtime_name);
    END IF;
    IF relation_name = 'signup_idempotency_claims' THEN
      -- SELECT FOR UPDATE requires UPDATE on at least one column. The CHECK
      -- constraint fixes this inert column to false; identity/binding stay sealed.
      EXECUTE pg_catalog.format('GRANT UPDATE (lock_anchor) ON TABLE public.%I TO %I', relation_name, runtime_name);
    END IF;

    -- Effective checks include PUBLIC and column ACLs, not just direct grants.
    IF pg_catalog.has_table_privilege(runtime_name, relation_oid,
        'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN,SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION')
        OR pg_catalog.has_any_column_privilege(runtime_name, relation_oid, 'REFERENCES') THEN
      RAISE EXCEPTION 'Unsafe effective table privileges';
    END IF;
    FOR column_info IN SELECT attname FROM pg_catalog.pg_attribute
        WHERE attrelid = relation_oid AND attnum > 0 AND NOT attisdropped LOOP
      IF NOT pg_catalog.has_column_privilege(runtime_name, relation_oid, column_info.attname, 'SELECT')
          OR pg_catalog.has_column_privilege(runtime_name, relation_oid, column_info.attname, 'INSERT')
             IS DISTINCT FROM (relation_name <> 'signup_idempotency_namespace')
          OR pg_catalog.has_column_privilege(runtime_name, relation_oid, column_info.attname,
             'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION')
          OR pg_catalog.has_column_privilege(runtime_name, relation_oid, column_info.attname, 'UPDATE')
             IS DISTINCT FROM (relation_name = 'signup_idempotency_claims' AND column_info.attname = 'lock_anchor') THEN
        RAISE EXCEPTION 'Unsafe effective table privileges';
      END IF;
    END LOOP;
  END LOOP;

  IF pg_catalog.has_database_privilege(runtime_name, pg_catalog.current_database(), 'CREATE,TEMPORARY')
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_'
        AND nspname <> 'information_schema'
        AND pg_catalog.has_schema_privilege(runtime_name, oid, 'CREATE')) THEN
    RAISE EXCEPTION 'Unsafe effective database or schema privileges';
  END IF;
  -- A writable owner-backed view/rule could bypass table ACLs. This principal
  -- must have no access to other application relations or sequences.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      AND c.oid NOT IN ('public.users'::regclass, 'public.password_credentials'::regclass,
                       'public.security_audit_events'::regclass,
                       'public.signup_idempotency_claims'::regclass, 'public.signup_idempotency_results'::regclass,
                       'public.signup_idempotency_namespace'::regclass, 'public.signup_idempotency_terminal_events'::regclass, 'public.verification_events'::regclass)
      AND ((c.relkind IN ('r','p','v','m','f') AND (
        pg_catalog.has_table_privilege(runtime_name, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        OR pg_catalog.has_any_column_privilege(runtime_name, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')))
        OR (c.relkind = 'S' AND pg_catalog.has_sequence_privilege(runtime_name, c.oid, 'SELECT,USAGE,UPDATE')))
  ) THEN
    RAISE EXCEPTION 'Unsafe effective privileges outside signup tables';
  END IF;
  -- Do not overlook direct grants on system catalogs or built-in routines.
  -- Those are outside the normal PUBLIC catalog-read/function defaults.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    WHERE c.oid NOT IN ('public.users'::regclass, 'public.password_credentials'::regclass,
                       'public.security_audit_events'::regclass,
                       'public.signup_idempotency_claims'::regclass, 'public.signup_idempotency_results'::regclass,
                       'public.signup_idempotency_namespace'::regclass, 'public.signup_idempotency_terminal_events'::regclass, 'public.verification_events'::regclass)
      AND (EXISTS (SELECT 1 FROM pg_catalog.aclexplode(c.relacl) acl WHERE acl.grantee = runtime_role.oid)
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a,
          LATERAL pg_catalog.aclexplode(a.attacl) acl
          WHERE a.attrelid = c.oid AND acl.grantee = runtime_role.oid))
  ) THEN
    RAISE EXCEPTION 'Unsafe explicit privileges outside signup tables';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(p.proacl) acl WHERE acl.grantee = runtime_role.oid) THEN
    RAISE EXCEPTION 'Unsafe explicit routine privileges';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      AND pg_catalog.has_function_privilege(runtime_name, p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'Runtime role can execute a SECURITY DEFINER routine';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_parameter_acl
      WHERE pg_catalog.has_parameter_privilege(runtime_name, parname, 'SET,ALTER SYSTEM')) THEN
    RAISE EXCEPTION 'Unsafe runtime server-parameter privileges';
  END IF;
END
$authcore_runtime$;
