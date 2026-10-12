# Integration Checkpoint

Verified: 2026-10-12 (Asia/Rangoon).

Implementation baseline: `d51559cfb3ec614d158ae4dd3b3f63baaefa234b`.
Documentation reconciliation does not change this implementation milestone.

| Milestone | Merge commit | Post-merge evidence |
| --- | --- | --- |
| [PR #7](https://github.com/ryukkfk/authcore/pull/7): transactional signup audit | `216f4d2b8b00e813c4d580ca98b3a17cfb309181` | [CI #16](https://github.com/ryukkfk/authcore/actions/runs/38044394113) passed |
| [PR #8](https://github.com/ryukkfk/authcore/pull/8): runtime permissions | `d6293312a00f75318f107f1caf69ec5db8141289` | [CI #19](https://github.com/ryukkfk/authcore/actions/runs/38049908485) passed |
| [PR #9](https://github.com/ryukkfk/authcore/pull/9): Phase A foundation | `d51559cfb3ec614d158ae4dd3b3f63baaefa234b` | [CI #21](https://github.com/ryukkfk/authcore/actions/runs/38075918583) passed |

CI #21 job logs establish workspace 214, PostgreSQL integration 99, Redis 28,
and HTTP E2E 9: **350 distinct passed tests**, plus lint, build and typecheck.
The former PR #8 candidate head `98073418567d5f290dc56252b0f928ebed25a6cd`
and [CI #17](https://github.com/ryukkfk/authcore/actions/runs/38047352812)
remain historical: 168 + 55 + 28 + 9 = 260 distinct tests. They do not validate PR #9.
All three PRs are merged; the old Draft status applies only to that dated snapshot.

## Implemented boundary

Phase A supplies HMAC binding, durable claims, immutable results and repository
locking primitives. It is inactive foundation; HTTP signup does not orchestrate it.
The exact runtime model covers `users`, `password_credentials`,
`security_audit_events`, `signup_idempotency_claims`, `signup_idempotency_results`.
Only `signup_idempotency_claims.lock_anchor` has column UPDATE for row locking;
its CHECK fixes it to false. Other claim fields and existing results/audit history
cannot be updated/deleted/truncated by the properly provisioned restricted login.
Owners/superusers can still alter audit history. Storage is not tamper-evident;
allowed direct INSERT can choose new-row values. Live credential adoption is unverified.

## Remaining work

- HTTP `Idempotency-Key` enforcement and SignupService orchestration.
- COMMIT acknowledgment and unknown-outcome recovery; absent result does not prove rollback.
- Distributed lease/COMMIT fencing and admission-slot/capacity coordination.
- HMAC secret/version rotation with cross-version reconciliation; retain one active secret/version throughout active claim retention today.
- Idempotency expiry/replay policy, retention and cleanup; audit retention/account deletion.
- Registration policy, email ownership verification/delivery and unverified-account access restrictions.
- Timing-resistant enumeration protection, independent security review and production operational validation.

`SIGNUP_ENABLED=false` remains the source default. AUTH-001 remains incomplete.
Production readiness is not established. Owner-recorded development risk acceptance
is not independent human security approval. No deployment, live grants, credentials,
environment edits or public enablement are authorized by this documentation.

Next recommended development task: review the Phase B HTTP/service orchestration
contract and unknown-COMMIT/fencing/admission design before implementing HTTP replay.
Add security regressions for the approved contract; keep signup disabled.

See [Development Status](Development%20Status.md), [Roadmap](Roadmap.md), [Runtime Permissions Checkpoint](Runtime%20Permissions%20Checkpoint.md),
[Security Defaults](Security%20Defaults.md) and [Documentation Synchronization](Documentation%20Synchronization.md).
