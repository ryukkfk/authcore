# Signup runtime database permissions

This development slice supplies explicit permission provisioning and isolated
regressions for the current signup schema. It does not change any existing
application login, `.env`, container, production database or API startup behavior.
`SIGNUP_ENABLED=false` remains the source default.

## Principals and guarantees

Use a dedicated PostgreSQL login for the application, distinct from the
database/schema/table owner and the migration operator. The runtime login must
not own database objects, hold administrative role attributes or belong to any
other role, including a NOINHERIT membership that permits SET ROLE.

The permission artifact replaces that login's direct privileges on the current
database, public schema and three signup tables. It grants CONNECT, schema USAGE,
table SELECT (needed by lookups and RETURNING), and table INSERT. Current
repositories supply these fields and use database defaults for the others:

| Table                 | Repository-supplied fields   |
| --------------------- | ---------------------------- |
| users                 | email, email_normalized      |
| password_credentials  | user_id, password_hash       |
| security_audit_events | event_type, user_id, payload |

The login cannot mutate or truncate existing audit rows, modify the schema,
grant those permissions, or assume the owner role. The
existing CHECK, uniqueness and foreign-key constraints remain unchanged. The
owner/migration operator can still maintain the schema.

Drizzle's current INSERT statements explicitly list defaulted columns too.
PostgreSQL requires INSERT permission on every listed column, even for DEFAULT.
Column-only grants broke the real signup E2E flow, so this slice preserves the
existing repositories and grants table INSERT. A direct SQL writer can therefore
choose values for new audit IDs/timestamps; normal repository input allowlisting
still ignores such fields. This protects existing rows, not the truthfulness of
every append after full application compromise.

Effective checks reject incompatible PUBLIC grants, independent column grants,
schema/database CREATE or TEMPORARY privileges, access to other application
relations/sequences (including writable owner-backed views), callable application
SECURITY DEFINER routines, explicit routine/system-catalog grants, and grants for
privileged server parameters. Direct
column ACLs on the three tables are revoked as well as table ACLs. A failure rolls
back all provisioning changes; the artifact does not repair PUBLIC, memberships,
role attributes or other objects automatically. Runtime permissions on other
databases and the server's PUBLIC built-in/extension permission policy must be
reviewed separately before any real-environment adoption. Standard PUBLIC access
to PostgreSQL catalog reads and built-in functions is not rewritten.

## Explicit provisioning artifact

After applying schema migrations, an authorized operator can invoke
`permissions/provision-signup-runtime.psql` with an existing dedicated runtime
login. The operator must have the rights to manage grants on the selected
database, public schema and the three tables; the runtime principal must be
different. PostgreSQL 17+ is required by the existing signup transaction limits
and the privilege checks.

From the repository root, with owner connection details supplied privately using
normal PostgreSQL connection facilities (for example a protected service/passfile):

```text
psql --set=runtime_role=authcore_runtime --file=packages/db/permissions/provision-signup-runtime.psql
```

The wrapper enables ON_ERROR_STOP, sets a transaction-local role-name parameter,
includes the same SQL exercised by the tests, and commits only after all effective
privilege checks pass. Role identifiers are validated and quoted; no password is
accepted by the artifact. It creates no role and changes no role attributes.

Fresh PostgreSQL databases normally grant TEMPORARY to PUBLIC. The artifact
deliberately rejects that unsafe effective privilege instead of silently changing
all database users. The isolated suites explicitly revoke it only in their own
disposable databases. For an existing environment, review any necessary PUBLIC
or ownership correction with its operator; do not run broad revocations against
shared databases as a shortcut. No such real-environment changes were performed.

Before an authorized real-environment adoption, stop/drain existing runtime
connections and inspect ownership, memberships, PUBLIC grants and other grants.
Existing sessions, temporary objects and a concurrent administrator changing ACLs
are not made safe by a provisioning script. Reconnect with genuinely restricted
credentials and verify permissions after any later migration or grant change.
This artifact is not a continuous enforcement daemon or a production rollout.

Application connections continue to read `DATABASE_URL`; migration commands
continue to read the migration operator's separately supplied environment. This
slice does not rewrite either value or auto-run permission provisioning. Do not
run migrations using the restricted application login. Rollback of operational
adoption requires a separately reviewed credential/grant decision; do not restore
broad audit mutation privileges just to make application startup succeed.

## Regression coverage and isolation

`src/runtime-role.integration.test.ts` creates a UUID-named test database and
LOGIN role, applies the existing migrations and the provisioning artifact, and
authenticates over PostgreSQL with the test role's own synthetic password. Both
current_user and session_user must identify that login. It tests direct and
column ACL removal, destructive operations, role/ownership escalation,
PUBLIC grants, writable views, callable SECURITY DEFINER routines, invalid
identifiers, atomic rollback and repeatability.

The combined HTTP/Redis/PostgreSQL E2E suite now uses a distinct restricted login
for every signup. Owner connections are limited to fixtures, fault injection,
observations and cleanup. Existing lease-loss, rollback/recovery and duplicate
cases run through that login. New cases verify Argon2 credentials and all three
committed rows, denied audit mutation, and sanitized HTTP failure with complete
rollback after audit INSERT permission is revoked in the disposable database.

Tests opt into `TEST_DATABASE_URL` for local port 5432 `authcore_test`, never an
application `.env`. Setup requires an isolated test administrator with CREATEDB
and CREATEROLE. All test role names and databases are UUID-owned; cleanup closes
connections, drops only the suite's database, then drops only its runtime role,
including when later setup fails. Database and role inventories were compared
around local validation. Redis uses UUID namespaces on dedicated port 6380; no
FLUSH operation is introduced. Existing CI already runs both test suites.

## Limits

Permissions protect history against this runtime principal, not a database owner
or superuser. They do not make storage tamper-evident or prevent misuse of the
permitted append operation after full application compromise. Live runtime roles
have not been switched, so this development change alone does not establish that
any existing environment already has restricted credentials.

Retention/account deletion, distributed lease/COMMIT fencing, unknown COMMIT
reconciliation/idempotency, registration policy, verification delivery, timing
resistance and production operational validation remain unresolved. The PR #7
owner exception remains limited to that earlier development merge; it is not
independent human security review of this change.

References: [PostgreSQL privileges](https://www.postgresql.org/docs/17/ddl-priv.html),
[privilege inquiries](https://www.postgresql.org/docs/17/functions-info.html),
[role membership](https://www.postgresql.org/docs/17/role-membership.html).
