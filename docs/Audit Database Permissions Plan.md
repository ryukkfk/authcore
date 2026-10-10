# Audit Database Permissions Plan

Prepared: 2026-10-10 (Asia/Rangoon)

Status: Implemented and locally tested on `feat/audit-runtime-permissions`;
not merged or applied to live runtime roles.
See [[Development Status]], [[Identity Foundation]], [[Roadmap]] and [[Security Defaults]].

## Verified starting point

- PR #7 merged into `main` with merge commit `216f4d2b8b00e813c4d580ca98b3a17cfb309181`.
- The merged tree matches submitted head `a2999cc87969aba161cab8316c6cb28ab7bc4ae8` (tree `4d5bdc616db91b9234f518d86a7b821ada8a23bf`).
- Post-merge CI run #16, run ID `38044394113`, completed successfully. Lint, build, typecheck, workspace tests, PostgreSQL integration, Redis integration and combined HTTP/Redis/PostgreSQL E2E steps all completed successfully.
- The registration environment schema still defaults `SIGNUP_ENABLED` to false.
- PR #7 has an owner-recorded development-only review-risk exception. It is not independent human security approval or production approval.
- The repository has no open GitHub issues returned by the current issue search.

Evidence:

- [Merged PR #7](https://github.com/ryukkfk/authcore/pull/7)
- [Post-merge CI](https://github.com/ryukkfk/authcore/actions/runs/38044394113)
- [Owner risk exception](https://github.com/ryukkfk/authcore/pull/7#issuecomment-6096463245)

## Current slice: audit runtime database permissions

Goal: provide a narrowly scoped runtime privilege configuration and prove that the application can append a signup audit event while being unable to alter or remove existing audit history.

Reason for sequencing: transactional audit storage has landed, but its documentation explicitly says database-enforced append-only protection is absent. The source uses `DATABASE_URL` for both runtime connections and migrations and defines no separate restricted runtime role. Compose's bootstrap PostgreSQL role is not evidence of a restricted application role. Actual deployed database roles and credentials were not inspected.

The existing roadmap names registration policy and verification events as the next AUTH-001 feature work. Audit privilege hardening is a recommended security follow-up before adding that feature; it does not complete AUTH-001 or waive the other launch blockers.

### Implementation boundary

1. Define separate database ownership/migration and application-runtime responsibilities. The runtime principal must not own the database, schema or tables, hold superuser/role-administration capabilities, or inherit or switch into an owner role.
2. Prepare explicit, reviewable permission provisioning for an already-created runtime principal. Avoid adding cluster-wide role creation to ordinary schema migrations. Do not embed passwords or broadly grant permissions on all future tables.
3. Grant only the permissions needed by current repositories. Audit insertion uses `RETURNING`, so account for necessary read access. Deny audit UPDATE, DELETE and TRUNCATE, ownership/DDL changes, and privilege escalation. Account for PUBLIC grants, inherited grants and grants on columns.
4. Add isolated PostgreSQL permission regressions and a signup test using a restricted runtime context. Exercise the same provisioning artifact used by the design, rather than testing a second copy of its SQL.
5. Refresh current-state documentation while preserving dated historical checkpoints and the owner exception's limited scope.

Suggested affected paths: a new database-permission provisioning artifact and operating note under `packages/db`; PostgreSQL permission integration tests; signup PostgreSQL integration coverage; `docs/Development Status.md`, `docs/Identity Foundation.md`, `docs/Roadmap.md`, and `apps/api/SIGNUP_TRANSACTIONAL_AUDIT.md`.

Do not modify prior schema migrations merely to rewrite history. A new schema migration is necessary only if the chosen implementation changes schema. Provisioning privileges must not silently run against an application database as a side effect of tests.

### Acceptance scenarios

| Scenario                                          | Required evidence                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Signup as restricted runtime principal            | User, credential and audit rows commit together                                               |
| Audit write denied or otherwise fails             | User and credential roll back; safe failure behavior remains                                  |
| Runtime attempts audit UPDATE, DELETE or TRUNCATE | PostgreSQL rejects each operation; audit rows remain unchanged                                |
| Runtime attempts ALTER/DROP or grant escalation   | Rejected; principal cannot assume the owning role                                             |
| Duplicate or concurrent signup                    | Existing credential and audit behavior remains unchanged                                      |
| Deployment with inherited/broad permissions       | Provisioning/preflight rejects incompatible privilege assumptions or explicitly reports them  |
| Existing schema migration workflow                | Still usable by the separate owner/migration principal                                        |
| Disabled signup                                   | Default remains false; disabled requests still do no signup work                              |
| Test cleanup                                      | Only test-owned random databases/roles are removed; cleanup works after partial setup failure |

Use test-owned role names if a real role is created. PostgreSQL roles are cluster-wide, so creation requires an explicitly suitable isolated test administrator, bounded cleanup and no use of application `.env` credentials. A test using SET ROLE must establish that the effective principal actually has restricted privileges; an administrative login alone cannot demonstrate safe production credentials.

### Validation and completion

- Run lint, build, typecheck and workspace tests.
- Run PostgreSQL integration tests with zero unreported skips, including permission-denial cases and restricted-role signup.
- Run existing Redis integration and combined HTTP/Redis/PostgreSQL E2E suites.
- Verify changed-file formatting, whitespace, migration consistency when relevant, and final changed-file inventory.
- Review and prepare the exact diff as a development-only change. Any subsequent merge needs authorization for that PR/revision; the completed authorization for PR #7 does not authorize merging a new PR.

The permission artifact and regressions are implemented and tested in an isolated
checkout based on the merged checkpoint above. The focused denial test failed
against a no-op baseline before enforcement. Local validation passed lint, build,
typecheck and 260 distinct tests: workspace 168, PostgreSQL 55 (30 permission
cases), Redis 28 and combined E2E 9. There were no skips in these suites, and
database/role inventories matched before and after each local database suite.
See [[Development Status]] and
[Signup runtime permissions](../packages/db/SIGNUP_RUNTIME_PERMISSIONS.md).
The runtime credential rollout and independent human review have not occurred.

## Documentation checkpoint

This documentation refresh replaces stale uncommitted/CI-pending assertions with the merged PR #7 checkpoint and post-merge CI evidence. Development Status, Identity Foundation, Roadmap, Security Defaults and the linked transactional audit note are updated together. Old local verification counts remain attributed to the user, and dated historical checkpoints are preserved. That earlier documentation-only refresh did not rerun application tests. The
subsequent implementation checkpoint above records fresh local test execution.

## Boundaries and remaining risks

Keep `SIGNUP_ENABLED=false`. Do not deploy, alter production settings, change actual credentials/roles or environment files, recreate containers, or run migrations against existing application databases.

Restricted runtime privileges do not prevent a database owner or superuser from changing audit history and do not make storage tamper-evident. Audit retention/account deletion, Redis-to-PostgreSQL COMMIT fencing, unknown COMMIT reconciliation/idempotency, registration policy, verification delivery and timing-resistant enumeration protection remain separate work.

PostgreSQL references used for the design:

- [Privileges and ownership](https://www.postgresql.org/docs/17/ddl-priv.html)
- [Role attributes](https://www.postgresql.org/docs/17/role-attributes.html)
- [SET ROLE](https://www.postgresql.org/docs/17/sql-set-role.html)
