# Phase B audit remediation and integration gates

Baseline: `0d7120b99208621e99a50e1f4ef0c7b89ddd8436` (S6, PR #20).
This change is implementer remediation, pending independent human security review.
Signup remains disabled by default. This document does not authorize integration,
deployment, public signup or AUTH-001 activation.

## PB-001: account writer inventory and boundary

The exported `IdentityService.createUser` previously called a pool-bound
`UserRepository.create` without admission, T1, credentials, audit or result.
No production caller of that legacy method was found. It has been removed.
`DatabaseModule` no longer provides or exports a pool-bound `UserRepository`.
`IdentityService` retains normalized lookup through a frozen lookup-only facade;
the underlying repository stays inside its composition closure.

| Production component                                    | Capability / protocol                                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AuthController` -> `SignupService`                     | Validated, default-disabled HTTP entry; admitted keyed protocol                                                                                                           |
| `IdempotentSignupService`, `signup-protocol.service.ts` | Sole application account writer: T2 owned transaction after admission, T1, namespace verification, slot/claim locking, fresh result/terminal/expiry checks and privileges |
| `UserRepository.create`                                 | Transaction primitive; T2 creates the user                                                                                                                                |
| `PasswordCredentialRepository.create`                   | Same T2 creates its credential                                                                                                                                            |
| `SecurityAuditEventRepository.recordUserCreated`        | Same T2 creates the mandatory audit event                                                                                                                                 |
| `SignupIdempotencyResultRepository.recordAccepted`      | Same T2 commits fixed accepted result; duplicates preserve existing credentials/audit                                                                                     |
| `SignupIdempotencyClaimRepository.reserve`              | T1 claim only; no account writes                                                                                                                                          |
| `inspectSignupClaim`                                    | Durable terminal event only, under owned execution policy                                                                                                                 |
| `IdentityModule` lookup facade                          | Read-only user lookup; no writer object escapes                                                                                                                           |
| `DatabaseService` consumers                             | Database composition, identity lookup composition, signup composition, health check                                                                                       |
| Web, worker, scripts                                    | No production account writer or direct domain INSERT                                                                                                                      |

`verify-account-writers.mjs` uses the TypeScript AST to reconcile production
INSERT sites, account repository imports, and DatabaseService consumers; it
rejects unreviewed inventory changes and direct literal account SQL. The runtime
boundary tests inspect actual Nest providers/exports and the lookup capability,
rather than relying on the removed method name. The production artifact guard
checks compiled providers and read API and rejects test/test-support imports.
Existing restricted-role S4 tests independently witness user/credential/audit/result
atomicity and rollback on failed companion writes. Disabled-route HTTP tests remain
required. Historical Phase A writers and fixtures are test-only and excluded from dist.

These checks cover the reviewed repository, not arbitrary dynamic code or an
external/admin/deployed writer. Persistence primitives and DatabaseService remain
trusted infrastructure needed by T2. They are not a sandbox against malicious
application code. New provisioning/import writers require a separately reviewed
protocol and updated inventory; do not silently route them into signup.

## PB-002: PostgreSQL expiry authority

The finite Date check remains; the `Date.now()` comparison is removed. PostgreSQL's
unchanged `signup_idempotency_claims_expiry_check` decides new persisted expiry:
finite timestamps and `expires_at > created_at`, where default `created_at` is
PostgreSQL transaction time at `timestamptz(3)` precision. Equality is invalid.
No extra clock query, migration, changed grant or weakened constraint is needed.
This preserves the existing database boundary; it does not redefine it as wall
clock at INSERT completion. T1 still calculates a positive bounded execution window
from `readSignupDatabaseClock`; T2 freshly decides execution eligibility.

Retained bindings are read first and never rebound or renewed. Finite stale inputs
reach the database instead of a competing application clock. Only SQLSTATE `23514`
plus the exact expiry constraint becomes the sanitized expiry error; unrelated
constraints and SQL failures propagate. Failed owned transactions still roll back.
A committed terminal event remains authoritative through backward time.

`phase-b-remediation.integration.test.ts` requires explicit approval and genuine
GitHub-hosted disposable PostgreSQL/Redis. Ten regressions use independent owner
connections to witness committed state, constraint fields, no partial domain work,
retained claim identity and terminal history. Date.now spies are process-local;
no host or PostgreSQL clock is changed. Test 10 injects an invalid expiry into the
real repository while retaining real SQL, admission, owner rollback and protocol
mapping; the existing controlled internal failure contract is preserved.

## PB-003: MANUAL GOVERNANCE GATE

The current public snapshot has unprotected branches and no visible rulesets.
The integration can read repository metadata but `main/protection` returns
`403 Resource not accessible by integration`; a metadata admin boolean does not
prove administration API scope. No review or protection is inferred from CI.
Owner action and independently verified effective settings are BLOCKED gates.

Apply protection to `main` and every current stacked PR base (including S6):

- Require at least one qualified independent human approval; the author's
  self-review is insufficient. For security changes require an explicitly assigned
  security reviewer. If using CODEOWNERS, name actual qualified owners first.
- Dismiss stale approvals and require approval of the latest reviewable push.
- Require `Verify` from GitHub Actions and strict up-to-date branch validation;
  inspect the exact head, current base, tested merge SHA and parent evidence.
- Require conversation resolution. Require PRs for all changes, including admins;
  prohibit unreviewed direct pushes. Enable administrator enforcement / no bypass.
- Prohibit force pushes and branch deletion. Do not grant additional administrators.

In Settings -> Rules -> Rulesets or Settings -> Branches, configure these controls,
then have an authorized independent reviewer read the effective settings/API and
record the reviewer, branch scope, check source, bypass policy and stale-review
behavior. Public repositories support protected branches on GitHub Free; account
plan and feature availability still require owner verification. This repository's
merge queue is not configured/verified. Do not enable a queue without first adding
and validating the required `merge_group` checks for its tested merge candidates.

## PB-004: fresh merged-candidate validation

CI now includes the remediation push branch, S6 as a PR base, and explicit
`opened`, `synchronize`, `reopened`, `edited`, `ready_for_review` PR activity types.
An edit revalidates the merge tree, including retarget edits, even when the head
has not changed. No privileged `pull_request_target`, production secret or write
permission is introduced. The read-only PR permission verifies live candidate state;
checkout does not retain credentials. PostgreSQL/Redis remain test-only job services.

Before and after tests, `verify-ci-candidate.mjs` checks checkout SHA, exact PR
merge parents against event base/head, and the live PR head/base/ref via GitHub.
A stale event rerun fails when live base/head differs. Candidate metadata is retained
with the summary and identity map. A push run proves its exact head; it does not
replace the PR merged-candidate run. No existing stacked PR is retargeted here.

After an upstream merge/base push, the integration owner must retarget the child
when appropriate and require a new successful current-base PR run. Automatic
base-branch-push behavior is not assumed. If no fresh run appears, edit the PR title
or description to generate a new `edited` event, then verify the new run's live
base/head and parents. Do not simply rerun an old event and count it as a new base.
Strict governance and a final live-state comparison are mandatory because a base
can change after a job completes. No old green check alone proves readiness.

Official references: [PR event behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request),
[protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

## INFO-001: sanitized assertion identities

`phase-b-test-identities.json` publishes repository-relative suite identifiers,
SHA-256 of normalized suite plus full assertion name, PASS/FAIL/SKIP, execution
category/report, guarded/reconciled status, exact PR head, tested SHA, base and run
ID. Raw names, assertion inputs/errors, credentials, SQL payloads, HMAC bindings
and private paths are excluded. The summary deduplicates focused executions and
still fails missing reports, failures and uncovered skips. Five Node regression
tests cover duplicate reconciliation, missing evidence, failed duplicates,
uncovered identities and unsafe suite paths. These five evidence-tool tests are
reported separately from the Vitest distinct count. Runtime privilege ownership
cases use stable kind labels instead of randomized disposable database names,
while preserving their real SQL and all privilege assertions.

## Review and release boundary

Require full exact-head CI, every real guarded suite, final-base CI, approved
PB-001/PB-002 dispositions and verified governance before integration. Green code
checks do not provide independent security approval. Production OPS-01 through
OPS-13, external writer rollout and AUTH-001 gates remain separate. Preserve
HMAC v1, immutable ledger/terminal history, driver patch, T1/T2/T3, Redis admission,
exact 202, and default-disabled policy. No merge, deployment or activation occurs
as part of this remediation.

## Initial hosted remediation evidence

Implementation head `ee71e0e76ff571406d9a2284ccc1a86df77d2268` passed
[push CI38841804377](https://github.com/ryukkfk/authcore/actions/runs/38841804377)
and [opened PR CI38841844828](https://github.com/ryukkfk/authcore/actions/runs/38841844828).
The PR tested merge `fa0ec6e88b97a07789b2dbea580b4b1b55fce118`
into S6 `0d7120b99208621e99a50e1f4ef0c7b89ddd8436`.
Results:683 distinct Vitest passes,0 failures/0 uncovered skips,88 guarded
executions reconciled,10/10 new real PostgreSQL regressions,57/57 real HTTP,
28/28 Redis and5/5 separate evidence-tool regressions. All inherited dedicated
A1/S1/S2/S3/S4/S6 and migration/permission/artifact checks passed.

The sanitized artifact was independently downloaded and its SHA-256 matched
GitHub's published digest. All683 identities reconstructed every report's
PASS/SKIP/FAIL contributions without inflating focused reruns. Protected original
worktrees and historical audit evidence were unchanged.

This evidence describes the implementation head above. This documentation update
also exercises a real PR `synchronize` event; require successful exact updated-head
push and merged-candidate runs in PR #21 Checks before approving that revision.
PR editing is separately exercised without retargeting any historical PR. The
final reviewer must still compare live head/base/merge parents and verify governance.
Neither these successful checks nor the documentation constitute independent
human review, repository protection or production readiness.
