# AuthCore

AuthCore is an early-stage TypeScript identity and access management project.
It is building a modular backend around explicit security boundaries, PostgreSQL
transactions, and tested failure handling.

**Development only:** registration is incomplete and disabled by default
(`SIGNUP_ENABLED=false`). This repository is not a production-ready identity
provider. Public source availability does not yet include a project license;
see [Licensing](#licensing).

## What works today

The integrated `main` baseline audited on 14 October 2026 is
[`a0bd2d7`](https://github.com/ryukkfk/authcore/commit/a0bd2d7ff6499e393a3dabb46617f6292f23c84e).
It contains:

- A NestJS API with validated configuration, input validation, CORS configuration,
  safe unexpected-error responses, and health/readiness endpoints.
- PostgreSQL migrations and repositories for users and password credentials.
- Central Argon2id password hashing: 64 MiB memory, three iterations, parallelism
  one; the signup DTO accepts passwords from 12 to 128 characters.
- A development signup endpoint with Redis rate limiting, admission leases,
  transaction-local database timeouts, and atomic user/credential/audit writes.
- Restricted database-role provisioning artifacts and permission regression tests.
  Provisioning is an explicit operator step, separate from API startup.
- Inactive signup idempotency foundations: immutable claim/result persistence and
  versioned HMAC binding primitives. These are not yet wired to HTTP signup.
- Unit, PostgreSQL, Redis, and HTTP end-to-end test suites in GitHub Actions.

Login, browser sessions, email verification, password recovery, MFA, organizations,
memberships, RBAC, OAuth/OIDC, and passkeys remain roadmap work. The web and worker
applications are placeholders, not a usable dashboard or delivery worker.

### Phase B is under review

The earlier PostgreSQL pool release-listener blocker has development remediation
candidates. They are **Draft, unmerged PRs**, separate from the baseline above:

| Slice                                     | Review                                             |
| ----------------------------------------- | -------------------------------------------------- |
| Phase B design                            | [#11](https://github.com/ryukkfk/authcore/pull/11) |
| S0 COMMIT outcome characterization        | [#12](https://github.com/ryukkfk/authcore/pull/12) |
| A1 pinned PostgreSQL driver patches       | [#14](https://github.com/ryukkfk/authcore/pull/14) |
| S1 outcome-aware transaction ownership    | [#13](https://github.com/ryukkfk/authcore/pull/13) |
| S2 secure reservation and terminal expiry | [#15](https://github.com/ryukkfk/authcore/pull/15) |
| S3 PostgreSQL advisory-slot capacity      | [#16](https://github.com/ryukkfk/authcore/pull/16) |

S4 signup recovery orchestration, S5 HTTP idempotency, and S6 final adversarial
validation have not been established as complete. Successful candidate CI does
not establish independent security approval, merge, deployment, or activation.
See the dated [repository audit](docs/Repository%20Audit%202026-10-14.md).

## Architecture

The intended architecture is a modular monolith with a separate background worker.
PostgreSQL owns durable identity data; Redis supports ephemeral abuse controls.

| Directory                | Current responsibility                                            |
| ------------------------ | ----------------------------------------------------------------- |
| `apps/api`               | NestJS API, health checks, development signup, Redis controls     |
| `apps/web`               | Placeholder for a future frontend                                 |
| `apps/worker`            | Placeholder for background delivery/work                          |
| `packages/db`            | Drizzle schema, migrations, repositories, transaction ownership   |
| `packages/config`        | Environment validation and defaults                               |
| `packages/crypto`        | Argon2id hashing and signup HMAC primitives                       |
| `packages/contracts`     | Shared-contract placeholder                                       |
| `packages/observability` | Observability placeholder                                         |
| `packages/testing`       | Testing-package placeholder on `main`                             |
| `docs`                   | Architecture, threat model, requirements, roadmap, dated evidence |

## Local development

Prerequisites: Node.js 24 or newer (CI uses 24), pnpm **12.8.1**, Docker with Compose,
and available loopback ports 4000, 5432, and 6379. These instructions describe the
integrated baseline, not the additional configuration in Phase B PRs.

```sh
git clone https://github.com/ryukkfk/authcore.git
cd authcore
pnpm install --frozen-lockfile
```

Copy `.env.example` to `.env` at the repository root (`Copy-Item .env.example .env`
in PowerShell, or `cp .env.example .env` in a POSIX shell). Use the supplied example
credentials only for isolated local development. Keep `SIGNUP_ENABLED=false`.

```sh
docker compose up -d postgres redis
pnpm build
pnpm --filter @authcore/db db:migrate
pnpm --filter @authcore/api dev
```

`db:migrate` changes the database selected by `DATABASE_URL`; verify it points to
your disposable development database before running it. Compose binds both
services to IPv4 loopback and persists their data in named volumes.
The API command runs from `apps/api`, as required by the current `.env` loader;
launching the compiled entrypoint from the repository root changes that path.

| Variable                | Purpose/default in the example                               |
| ----------------------- | ------------------------------------------------------------ |
| `DATABASE_URL`          | Local PostgreSQL connection; required                        |
| `REDIS_URL`             | Local Redis connection; required                             |
| `API_HOST`, `API_PORT`  | `127.0.0.1`, `4000`                                          |
| `SIGNUP_ENABLED`        | Strict lowercase `true`/`false`; defaults to disabled        |
| `WEB_ORIGIN`            | Allowed CORS origin, `http://localhost:3000`; no web app yet |
| `NODE_ENV`, `LOG_LEVEL` | Development environment and log configuration                |

`.env` is ignored by Git. Do not put real credentials in documentation, issues,
command examples, or logs. The Compose database owner is a development convenience;
production least-privilege adoption is not demonstrated by this setup.

### Inspect the API

```sh
curl http://127.0.0.1:4000/api/v1/health
curl http://127.0.0.1:4000/api/v1/health/ready
```

Liveness returns `{"status":"ok","service":"authcore-api"}`. Readiness additionally
checks PostgreSQL and returns `"database":"ok"`; it does not verify Redis or full
signup readiness.

`POST /api/v1/auth/signup` returns 403 while disabled. In deliberately enabled,
isolated development tests, valid signup and duplicate-email requests return
202 with `{"status":"accepted"}`. Equal status/body does not prove timing-resistant
account-enumeration protection. The integrated route has no `Idempotency-Key`
enforcement or accepted-result replay. Do not enable it as a public service.

Stop local services with `docker compose stop`. Keep volumes unless you explicitly
intend to delete your development data.

## Validation

```sh
pnpm lint
pnpm build
pnpm typecheck
pnpm test
pnpm --filter @authcore/db test:integration
pnpm --filter @authcore/api test:redis
pnpm --filter @authcore/api test:e2e
```

Build precedes downstream checks because workspace packages expose `dist`
entrypoints. On Windows, use `pnpm.cmd` if the PowerShell shim is restricted;
no execution-policy change is needed.

Database suites require an explicitly selected `TEST_DATABASE_URL` for disposable
test infrastructure with permission to create and remove their random test
databases/roles. Never use a production URL. Some database-dependent tests skip
when that variable is absent, so a local green workspace run alone is insufficient.
Redis tests require the exact dedicated URL `redis://127.0.0.1:6380`, separate from
the Compose development Redis on 6379. HTTP E2E needs both test services.
See [Redis test isolation](apps/api/REDIS_INTEGRATION_TESTS.md) and
[runtime permission testing](packages/db/SIGNUP_RUNTIME_PERMISSIONS.md).

The baseline [CI run](https://github.com/ryukkfk/authcore/actions/runs/38207873631)
at `a0bd2d7` passed lint, build, typecheck, 214 workspace tests, 99 separate
PostgreSQL tests, 28 Redis tests, and 9 HTTP E2E tests: **350 distinct tests**.
This is dated CI evidence, not a stability, coverage-percentage, or production claim.
Placeholder packages with no test files are excluded from the count.

## Security and contribution

Read [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), and
[AGENTS.md](AGENTS.md) before proposing a change. Keep changes narrow, add
regressions for new security behavior, and use a reviewable PR with CI evidence.
Do not publish sensitive vulnerability details in an issue or PR.

Before any public activation, outstanding work includes transaction outcome and
recovery integration, independent security review, registration/verification
policy, timing analysis, deployment capacity and durability checks, restricted
runtime-role adoption, and retention/key-management decisions. Redis leases are
not PostgreSQL fencing tokens or a hard fleet-wide password-hashing memory bound.

## Documentation

- [Development status](docs/Development%20Status.md)
- [Roadmap](docs/Roadmap.md)
- [Architecture](docs/Architecture.md)
- [Threat model](docs/Threat%20Model.md)
- [Security requirements](docs/Security%20Requirements.md)
- [Idempotency foundations](packages/db/SIGNUP_IDEMPOTENCY.md)
- [Repository audit and maintenance evidence](docs/Repository%20Audit%202026-10-14.md)

## Licensing

No project license has been granted in this repository. Copyright ownership and
permission to license all contributions and incorporated material still need
confirmation. Dependency licenses do not license AuthCore itself. Do not assume
permission to reuse or redistribute project code from its public visibility.
An appropriate license will require a separate, rights-confirmed maintainer decision.
