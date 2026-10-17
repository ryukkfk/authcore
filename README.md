# AuthCore

AuthCore is a TypeScript identity and access management platform built as a
modular monolith with a separate background worker. PostgreSQL is the source of
truth; Redis supplies bounded abuse controls.

This branch is an **unmerged development candidate** on the Phase B security
stack. Independent human review and production release approval remain pending.
Passing tests do not authorize public registration or production deployment.

## Try the private local application

Requirements: Node.js 24+, pnpm 12.8.1, Docker Desktop with Linux containers and a
local Docker context. Run commands as your normal Windows user.

From the isolated engineering checkout:

```powershell
cd "C:\Users\Tin Aung Cho\authcore-full-product"
pnpm dev:setup
pnpm dev:start
```

Keep the startup terminal open. The preferred addresses are:

- Web: http://127.0.0.1:3000
- API: http://127.0.0.1:4000/api/v1/health
- Local-only test mailbox: http://127.0.0.1:8025

Setup checks port availability and selects safe alternatives when necessary.
The commands print the actual addresses; ignored .local-demo/public.json also
records them. No real provider or external email delivery is enabled.

Create an account, open the captured verification message, verify the email,
then sign in. The account workspace shows your verified profile and active
sessions. Sign out or revoke device access from Security & sessions.

```powershell
pnpm demo:check
pnpm dev:stop
```

Shutdown uses the owned supervisor and preserves PostgreSQL, Redis and mailbox
volumes. Ordinary startup reuses the existing secrets and namespace anchor.
Do not delete .local-demo or volumes to resolve a startup problem.

See [Local Demo](docs/Local%20Demo.md) for prerequisites, testing, configuration,
shutdown, port conflicts and troubleshooting. Browser acceptance evidence is
recorded in the development status; service readiness alone is not acceptance.

## Implemented in the development stack

- Sole secure signup protocol with mandatory Idempotency-Key, HMAC binding,
  PostgreSQL reservations/capacity, transaction ownership and unknown-COMMIT recovery.
- Durable transactional verification intent, restricted worker/verifier roles,
  retry/backoff/dead-letter auditing and local email capture.
- High-entropy, hashed, single-use email verification credentials with database expiry.
- Verified-account password login through the central Argon2id implementation.
- Hash-only opaque browser sessions, HttpOnly cookies, CSRF defense, expiry,
  rotation, device revocation and logout-all/others.
- React account UI with registration, verification, login, profile and session management.
- Real PostgreSQL, Redis, HTTP, concurrency/crash and browser test infrastructure.

These capabilities do not complete every acceptance criterion of AUTH-001,
VERIFY or SESSION tickets. Resend policy, account recovery, MFA, organizations,
memberships, RBAC/tenant isolation, authorized audit viewer and full V1 hardening
remain roadmap work. OAuth/OIDC, passkeys and risk controls follow the V1 gates.
See [Roadmap](docs/Roadmap.md) and [Development Status](docs/Development%20Status.md).

## Architecture

```text
Browser → React web → NestJS API → PostgreSQL
                         ↓             ↑
                       Redis       durable outbox
                                       ↓
                              independent worker
                                       ↓
                            local-only test mailbox
```

Applications: apps/web, apps/api, apps/worker.
Shared packages: db, contracts, config, crypto, observability, testing.
No microservices or second account writer are introduced.
See [Architecture](docs/Architecture.md), [Security Requirements](docs/Security%20Requirements.md),
[Threat Model](docs/Threat%20Model.md) and [Browser Authentication](docs/Browser%20Authentication.md).

## Development and tests

```powershell
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:local
```

The isolated Linux regression uses its own Compose project and real
PostgreSQL/Redis/Mailpit services. Historical hosted-only guarded tests run in
actual GitHub CI; local skips must not be counted as passes.

With the local demo running, pnpm test:e2e exercises real browser
signup/mail/verification/login/revocation/logout and ordinary restart persistence.
It deliberately restarts and then stops that named disposable demo. Run
pnpm dev:start again afterward. Windows uses installed Microsoft Edge with an
isolated test profile; Linux requires pnpm exec playwright install --with-deps chromium.
pnpm test:all combines the isolated regression and browser suite.

## Configuration and release boundaries

Production defaults fail closed. Local-demo provisioning is explicit, loopback-only,
uses a separate Compose project, and never provisions a production role or fallback
HMAC key. The normal API startup does not derive or create its own approved
attestation metadata. Secrets stay in ignored local files; never commit or publish them.

Runtime credentials differ by API capability and worker role. Production requires
reviewed secret-manager injection, TLS/proxy/cookie configuration, database privileges,
retention, durability/failover, backup/restore and capacity evidence. Native Argon2
ownership is per process, not a fleet-wide memory guarantee.

Development is not a security certification or a production support commitment.
Report security issues through [SECURITY.md](SECURITY.md). Use bounded, reviewed
changes and dependency-ordered Draft PRs; preserve required Verify checks and
qualifying independent approvals. See [AGENTS.md](AGENTS.md).

## Licensing

No project license has been confirmed. Source availability does not establish
permission to redistribute or relicense. Maintainer ownership/legal authorization
is required before selecting a project license. Retain third-party license notices.
Frontend dependency notices are retained in
[THIRD_PARTY_NOTICES.txt](apps/web/public/THIRD_PARTY_NOTICES.txt).
