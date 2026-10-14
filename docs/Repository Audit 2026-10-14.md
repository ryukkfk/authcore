# AuthCore repository audit — 14 October 2026

This is a dated assessment of public GitHub state and source, not an independent
security certification. It distinguishes integrated code, development candidates,
and deployment evidence. Facts must be refreshed before a release or application.

## Verified repository state

| Item                                     | Observation                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Repository                               | Public, non-fork `ryukkfk/authcore`; created 7 October 2026                                            |
| Integrated baseline                      | `a0bd2d7ff6499e393a3dabb46617f6292f23c84e` on `main`                                                   |
| History                                  | 24 commits reachable from that baseline, including merge commits                                       |
| Pull requests before this audit proposal | #1–#10 merged; #11–#16 open and Draft                                                                  |
| Community signals                        | 0 stars, 0 forks at audit time                                                                         |
| Releases                                 | No GitHub releases returned by the release listing                                                     |
| About                                    | Description/homepage unset; topics empty                                                               |
| Licensing                                | No tracked LICENSE/COPYING/NOTICE file or package license declaration found; GitHub detects no license |
| Branch enforcement                       | `main` returned `protected=false`; repository ruleset listing empty                                    |
| Review evidence                          | No submitted GitHub reviews returned for #11–#16                                                       |

Source: [repository metadata](https://api.github.com/repos/ryukkfk/authcore),
[branches](https://github.com/ryukkfk/authcore/branches),
[PRs](https://github.com/ryukkfk/authcore/pulls?q=is%3Apr), and
[releases](https://github.com/ryukkfk/authcore/releases). Maintainer account control
is evidence of administrative capability, not proof of copyright ownership.
No external users, monthly downloads, production deployments, service reliability,
or broad ecosystem adoption were established by this audit. `0.1.0` in private
workspace manifests is not proof of a published package or stable release.

## Findings and required follow-up

### High — transaction outcome defects remain in the integrated baseline

[`packages/db/src/signup-transaction.ts`](../packages/db/src/signup-transaction.ts)
awaits `COMMIT` without checking its command tag and throws a stored release failure
after the transaction otherwise succeeded. A swallowed PostgreSQL statement error
can leave the transaction aborted, causing a resolved COMMIT query to return
`ROLLBACK`; this owner can then return callback success. A controlled post-COMMIT
release exception can instead hide acknowledged success. These are characterized
in [S0 PR #12](https://github.com/ryukkfk/authcore/pull/12), including real PostgreSQL
witnesses. The injected lifecycle exception is not evidence of spontaneous normal
driver/network failure or a demonstrated unauthenticated exploit.

The consequence for enabled signup is incorrect client-visible outcome and unsafe
retry assumptions. Default-disabled signup limits current exposure. Review the
A1/S1 candidates and their exact tests before integrating; do not transplant a
partial disposal workaround or infer rollback from a closed socket. No runtime
repair or merge is performed by this documentation proposal.

### High — full registration recovery and production gates remain incomplete

The integrated `SignupService` writes user, credential, and audit rows atomically,
but does not write an accepted idempotency result or reconcile unknown COMMIT
outcomes. The controller does not require an `Idempotency-Key`. The S3 branch's
`SignupService` and controller remain unchanged from `main`; its independent HTTP
capacity harness is not a completed signup/replay implementation.

S4 orchestration, S5 HTTP integration, S6 adversarial completion, verification
delivery, timing-resistant enumeration controls, operational capacity/durability,
HMAC/retention policy, live restricted-role adoption, and independent human review
remain gates. Keep `SIGNUP_ENABLED=false`. Redis leases do not fence PostgreSQL
COMMIT or prove a fleet-wide Argon2 memory bound. The S3 gate bounds participating
SQL critical sections on its primary/database, not all hashing or all writers.

### High for OSS readiness — project licensing is unresolved

The empty README and absence of a license prevented visitors from understanding
both behavior and reuse terms. This proposal supplies substantive documentation
but intentionally grants no license. Visible author labels (`ryukkfk` and
`Tin Aung Cho`) do not exclude copied material, employer rights, or third-party
contributions. The maintainer has not confirmed complete licensing rights.

Before adding a license, establish authorship and any employer/client assignment,
inventory incorporated code/assets/generated material and applicable notices,
obtain necessary contributor permission, and choose distribution terms with the
rights holders. Preserve dependency notices and review the local PostgreSQL patch
provenance in #14. MIT metadata for dependencies does not license AuthCore itself.
[GitHub licensing guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)
explains why public visibility alone is insufficient.

### Medium — review gates are documented but not enforced by observed branch state

`AGENTS.md` requires security regression tests and review discipline, but `main`
is not marked protected and no repository rulesets were returned. Configure
appropriate required checks/reviews and restrict bypasses before security-critical
integration. Do not treat an empty review list as independent approval. External
reviews may exist elsewhere, but none were verified here. This audit does not
change repository access or branch settings.

### Medium — private security disclosure route is incomplete

`SECURITY.md` prohibits public findings but publishes neither a reporting address
nor a confirmed private reporting route. This proposal clarifies conditional use
of GitHub private vulnerability reporting and current development support status;
it does not claim the feature is enabled. The maintainer should enable and test a
private route and establish an achievable response process before inviting reports.
Do not publish exploit details to work around a missing channel.

### Medium — baseline CI has supply-chain and coverage limits

Positive evidence: read-only workflow permissions, frozen installation, Node 24,
pnpm 12.8.1, disposable PostgreSQL 17 and dedicated Redis 7, build before downstream
checks, and real integration/E2E steps. The baseline targets pushes and PRs to
`main`; stacked candidates have their own expanded triggers and dedicated gates.

The baseline references actions by major tags and services by mutable image tags.
It has no dependency-advisory, secret-scanning, or static security-analysis step in
the workflow. Platform-level security features were not inspected, so their
absence is not inferred. Recommend reviewed immutable action revisions, image
update policy, and a maintained advisory/secret-scanning process. A1/S1 candidates
already add driver integrity and production advisory checks; avoid duplicating
or accidentally dropping these when integrating.

Workspace tests include API PostgreSQL cases that skip without `TEST_DATABASE_URL`.
Placeholder packages use `--passWithNoTests`; their green result is not coverage.
The PR's test claims must name the suite, revision, failures, and skips. No numerical
coverage or exhaustive security assurance was measured. Existing broader formatting
debt is outside this narrow documentation proposal.

### Documentation — claims now distinguish implementation from intent

This proposal replaces the empty README with setup, API behavior, architecture,
limitations, roadmap links, validation commands, and licensing status. It adds
`CONTRIBUTING.md` and clarifies the security policy's planned session design.
Older detailed documents retain dated historical checkpoints; this dated audit
provides a newer inventory without rewriting historical results or personal notes.

## Phase B progress: historical blocker versus current candidates

The earlier `pg@8.23.1` / `pg-pool@3.14.0` investigation identified a controlled
release-listener exception after release-once consumption but before removal.
Actual transport closure could coexist with retained pool accounting and blocked
shutdown. That was a valid blocker at its historical revision.

Current development candidates advance beyond it:

| Slice  | Exact head                                 | Base branch | Verified CI                                                                 |
| ------ | ------------------------------------------ | ----------- | --------------------------------------------------------------------------- |
| S0 #12 | `822062fea79fad3e5a8547dc9f7b40b999f7cb71` | `main`      | [38232288230](https://github.com/ryukkfk/authcore/actions/runs/38232288230) |
| A1 #14 | `f969f2a559ec0be9e961e12d524f6a990e6c4177` | S0          | [38350195661](https://github.com/ryukkfk/authcore/actions/runs/38350195661) |
| S1 #13 | `ea9634dd2a1e00400ed5a3fc1de74fecdad4de35` | A1          | [38383133594](https://github.com/ryukkfk/authcore/actions/runs/38383133594) |
| S2 #15 | `51a0d1d6f4fb4d0dc2d5789e001eecfe26f63cb0` | S1          | [38504279637](https://github.com/ryukkfk/authcore/actions/runs/38504279637) |
| S3 #16 | `0985e009ab7393dff3b59595db124214a5e77301` | S2          | [38506170663](https://github.com/ryukkfk/authcore/actions/runs/38506170663) |

All were Draft and unmerged when checked. A1 pins and patches both driver packages,
updates the lockfile, and adds patch/source/license integrity checks. This is a
repository-maintained patch, not a verified upstream release fix. S1 replaces the
transaction owner. S2 adds migration `0004` for namespace and terminal events plus
restricted grants. S3 adds fixed advisory-slot capacity without a new migration.
None of those changes is integrated into the audited `main` baseline.

The latest development conversation contains approval to finish remaining stages,
but retrieved turns ended failed/interrupted and do not establish mission
completion. Repository state and actual checks take precedence over an intention
to complete work. S4–S6 completion and production activation were not verified.

## Test and maintenance evidence

Baseline [CI 38207873631](https://github.com/ryukkfk/authcore/actions/runs/38207873631)
at `a0bd2d7` completed successfully. Job logs show:

| Suite                                 |                   Passed |
| ------------------------------------- | -----------------------: |
| Workspace: config / crypto / DB / API | 24 / 33 / 44 / 113 = 214 |
| Separate PostgreSQL integration       |                       99 |
| Dedicated Redis integration           |                       28 |
| HTTP + PostgreSQL + Redis E2E         |                        9 |
| Distinct total                        |                      350 |

No test skips appeared in these baseline suite summaries. Five placeholder
workspaces reported no test files; they are not counted as tested features.

Latest S3 [CI 38506170663](https://github.com/ryukkfk/authcore/actions/runs/38506170663)
job logs show 326 workspace, 105 normal PostgreSQL, 3 A1 real database, 1 pool
ownership, 14 outcome, 19 S2 reservation, 14 S3 capacity, 28 Redis and 9 HTTP E2E
passed assertions: **519 distinct tests**. The pool case and gated integration
cases are excluded from aggregate configurations or skipped there, then run in
dedicated required steps. Aggregate API summaries show 33 skips, and ordinary DB
integration shows 18; the dedicated steps show zero skips. Do not report this as
"no skips anywhere" or add gated skips to passed totals. Lint/build/typecheck,
driver integrity and production advisory steps also succeeded at that candidate.

These are inspected GitHub results, not local reruns of those branches. The fresh
production dependency advisory scan of the baseline on 14 October 2026 returned
no known vulnerabilities. That only reflects advisory-database coverage at the
time; it is not proof that dependencies or the application are vulnerability-free.

Visible maintenance includes merged foundation PRs, narrow Draft implementation
slices, documented decisions, failed-run evidence followed by corrected candidates,
and service-backed regression testing. It does not establish community adoption,
support commitments, independent security approval, or production operation.

## Repository About suggestions

Suggested description:

> Early-stage TypeScript IAM backend with NestJS, PostgreSQL, and Redis; security-focused signup foundations. Development only; registration disabled by default.

Suggested topics: `typescript`, `nestjs`, `postgresql`, `redis`, `iam`,
`identity-management`, `authentication`, `security`, `work-in-progress`.

Leave Website empty until there is a real maintained documentation site or demo.
Do not add `production-ready`, a license badge, download counts, users, deployments,
or a security-audited claim without evidence. About changes are suggestions only.

## Audit scope and limits

Inspected source/configuration, migrations and grants, test configuration, history,
PR heads/bases/reviews, workflow definitions, and selected CI jobs/logs. Existing
project conversation history supplied chronology, not completion proof. No live
database, production role/secret, deployment environment, private vulnerability
backlog, or operational telemetry was inspected. This proposal changes documentation
only and does not resolve the runtime or licensing blockers identified above.
