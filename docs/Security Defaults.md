# Development Security Defaults

Last updated: 2026-10-10 (Asia/Rangoon)

## Merge scope

The signup foundation is development-only code. Public registration is disabled by
default in every NODE_ENV. These defaults support merging the foundation; they do
not make registration ready for public production use.

PR #7 is merged and post-merge CI passed. The owner-recorded development-only
review-risk exception does not authorize deployment or public registration.
See [[Development Status]] for the exact revision and evidence. This documentation
update does not change actual environment values, containers or runtime roles.

## Configuration

| Setting                   | Default             | Meaning                                   |
| ------------------------- | ------------------- | ----------------------------------------- |
| API_HOST                  | 127.0.0.1           | Bind the development API to IPv4 loopback |
| API_PORT                  | 4000                | Explicit ports remain supported           |
| SIGNUP_ENABLED            | false               | Disable the signup HTTP endpoint          |
| PostgreSQL published port | 127.0.0.1:5432:5432 | Host loopback only                        |
| Redis published port      | 127.0.0.1:6379:6379 | Host loopback only                        |

SIGNUP_ENABLED accepts only the exact lowercase strings true and false. Missing
means false; empty, numeric, mixed-case, padded and unknown values fail environment
validation. Do not use generic Boolean(string) coercion for this setting.

API_HOST can still be explicitly configured for a future controlled deployment,
including a container that needs a wildcard internal bind. That override does not
enable signup. CORS and NODE_ENV are not network access controls.

## HTTP policy

A Nest guard snapshots validated configuration at API startup. With signup disabled,
POST /api/v1/auth/signup returns HTTP 403 with:

```json
{ "error": { "code": "HTTP_403", "message": "Signup is disabled" } }
```

The guard runs before DTO validation and SignupService. Valid JSON requests receive
the same disabled response regardless of email/password validity. Framework parsing
errors (such as malformed JSON or an oversized body) may still be rejected earlier.
No password hashing, signup transaction or user/credential writes occur in the
disabled route. The API still initializes its database provider for other endpoints.
Internal SignupService calls are not gated; this flag controls the HTTP endpoint.

Only explicit SIGNUP_ENABLED=true enables isolated development testing. When enabled,
validation and the existing generic 202 success/duplicate response remain unchanged.
Restart the API after changing configuration; the guard is not a dynamic toggle.

## Logging

Unexpected HTTP errors log only the structured event http.unhandled_exception and
HTTP method. They do not log request URLs, query strings, bodies or raw exceptions.
The response remains the generic 500 INTERNAL_SERVER_ERROR contract.

## Applying defaults safely

Existing .env files and process environment overrides are not rewritten. Review
API_HOST and SIGNUP_ENABLED privately before starting the development API; copying
new example defaults is not automatic. Never paste environment values into logs.

Changing docker-compose.yml does not update already running container bindings.
Container recreation requires explicit operator approval. Preserve named volumes;
never use down -v or delete database data to apply a binding change. Windows firewall
rules are not changed by this hardening work.

After an approved container update, verify docker ps / projected port metadata shows
only 127.0.0.1 on 5432 and 6379. Verify the API listener with Get-NetTCPConnection,
and send a synthetic signup request with the flag absent/false: expect the disabled
403 response. Check from another LAN host when proving network isolation. Local
listener snapshots alone do not prove internet accessibility or its absence.

## Runtime database permissions candidate

An isolated development candidate adds explicit provisioning for a dedicated
SELECT/INSERT runtime login and tests denied audit mutation, DDL/escalation and
mandatory-audit failure rollback. The existing ORM requires INSERT privileges on
defaulted columns too, so direct SQL writers can choose values on newly appended
events; this does not make history tamper-evident.
No actual runtime credentials or roles have been switched. See
[runtime permissions](../packages/db/SIGNUP_RUNTIME_PERMISSIONS.md),
[[Audit Database Permissions Plan]] and [[Development Status]].

## Public enablement remains blocked

Rate limiting before hashing, admission abuse controls and transactional signup
audit storage are implemented and covered by current CI. They do not establish
public readiness or an atomic Redis/PostgreSQL execution fence.

Before public enablement, complete and review registration policy, email ownership
verification/delivery and unverified-account access restrictions, timing-resistant
enumeration defenses, review and authorized adoption of runtime-role protection,
retention/account-deletion
policy, COMMIT fencing and uncertain-outcome reconciliation, operational/capacity
validation, and controlled TLS/network exposure.
See [[Audit Database Permissions Plan]], [[Identity Foundation]],
[[Development Status]] and [[Roadmap]].
