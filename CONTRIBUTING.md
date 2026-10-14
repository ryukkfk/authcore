# Contributing to AuthCore

AuthCore is early-stage security-sensitive software. Registration remains disabled
by default and the project has not established production readiness.

## Before proposing work

Read [AGENTS.md](AGENTS.md), [the README](README.md), the
[roadmap](docs/Roadmap.md), and the relevant implementation notes. Check open
pull requests before duplicating work. Discuss non-sensitive behavior changes in
an issue with a concrete use case and acceptance criteria. Use synthetic examples
without credentials or personal data.

There is currently no project license or contributor licensing agreement.
Maintainers must resolve ownership and contribution terms before treating incoming
code as cleared for open-source distribution. Do not submit code you lack rights
to contribute, copy incompatible licensed material, or remove upstream notices.

## Development and validation

Follow [local setup and validation](README.md#local-development). The pnpm version
and lockfile are part of the reproducible build. Do not regenerate the lockfile for
a documentation-only change or enable dependency lifecycle scripts indiscriminately.

Before completing a change, run:

```sh
pnpm lint
pnpm build
pnpm typecheck
pnpm test
git diff --check
```

Run the relevant PostgreSQL, Redis, and HTTP E2E suites as described in the README.
Use disposable test services only. Report skipped tests and environmental limits;
do not present a suite with skipped database cases as full integration validation.
Existing GitHub CI runs the service-backed checks for PRs targeting `main`.

## Pull requests

Use a branch and a narrow PR. Explain the problem, resulting behavior, exact base
and head revisions, validation, material risks, and unresolved gates. For a stacked
PR, identify its dependency and verify that its target branch triggers the required
workflow. Documentation proposals do not authorize production changes.

Keep security controls intact. New security behavior requires regression tests.
Database changes require reviewed migrations; destructive data changes require
explicit review. Never weaken tests to produce a passing run. Do not enable public
signup, deploy, rotate production secrets, or grant live database privileges as
part of an ordinary contribution.

Green CI is necessary evidence, but does not replace required review or independent
security approval. Preserve historical failing evidence when it explains a repair.
AI-assisted work must meet the same review and testing requirements; model output
is not independent security certification.

## Security reports

Follow [SECURITY.md](SECURITY.md). Do not disclose credentials, sensitive exploits,
or real user data through public issues, PRs, or test fixtures. A private reporting
route must be confirmed before sending sensitive details.
