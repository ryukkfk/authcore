# Runtime Permissions Checkpoint

Historical snapshot: 2026-10-10 (Asia/Rangoon).

**Status at this historical checkpoint:** PR #8 was Draft/open, with its exact-head
[CI #17](https://github.com/ryukkfk/authcore/actions/runs/38047352812)
successful, pending review, and not merged or applied to live runtime roles **at
that time**. This is not the current repository status.

## Exact revision and recorded validation

- [PR #8](https://github.com/ryukkfk/authcore/pull/8) candidate head:
  `98073418567d5f290dc56252b0f928ebed25a6cd`.
- Candidate baseline: PR #7 merge
  `216f4d2b8b00e813c4d580ca98b3a17cfb309181`.
- Historical candidate: 11 changed files, one commit.
- [CI #17](https://github.com/ryukkfk/authcore/actions/runs/38047352812):
  lint/build/typecheck and workspace, PostgreSQL, Redis and HTTP E2E passed.
- Historical local result: **260 distinct tests** — workspace 168, isolated
  PostgreSQL 55, dedicated Redis 28, combined E2E 9, with zero failures/skips.
  Seventeen signup PostgreSQL cases are included in workspace, not added again.
- New regressions included 30 database permission cases and 2 HTTP E2E cases;
  audit UPDATE denial failed on the no-op baseline and passed with enforcement.
  Test-owned database and role inventories matched around the local suites.

## Historical permission boundary

At this checkpoint, the candidate provisioned a separate restricted runtime
LOGIN with SELECT/INSERT on **three** signup tables, blocking audit
UPDATE/DELETE/TRUNCATE, DDL and escalation. Genuine restricted E2E logins
exercised mandatory-audit rollback. Database owners/superusers could still change
audit history and direct SQL inserts could choose values on new rows; this did
not make storage tamper-evident. No live credentials/roles were changed.

## Later integration (not part of the 2026-10-10 candidate snapshot)

[PR #8](https://github.com/ryukkfk/authcore/pull/8) subsequently merged at
`d6293312a00f75318f107f1caf69ec5db8141289`; [PR #9](https://github.com/ryukkfk/authcore/pull/9)
merged at `d51559cfb3ec614d158ae4dd3b3f63baaefa234b`. The latter extended
runtime permission provisioning to **five** tables and permits UPDATE only on the
CHECK-constrained `signup_idempotency_claims.lock_anchor` column for row locking.
[CI #21](https://github.com/ryukkfk/authcore/actions/runs/38075918583)
passed against that merge with 350 distinct tests. Phase A is inactive foundation,
not HTTP idempotency or unknown COMMIT recovery.

The earlier PR #7 owner-recorded development-only risk exception and later
owner-only records do not constitute independent human security approval or
production authorization. Actual live role adoption was not established.
`SIGNUP_ENABLED=false` remains the source default; AUTH-001 and production
readiness are incomplete. This note must not be read as permission to deploy,
apply SQL grants, change credentials, run migrations or enable public signup.

See [Development Status](Development%20Status.md), [Audit Database Permissions Plan](Audit%20Database%20Permissions%20Plan.md),
[Security Defaults](Security%20Defaults.md) and [Roadmap](Roadmap.md).
