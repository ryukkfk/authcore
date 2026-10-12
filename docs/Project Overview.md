# AuthCore

Implementation checkpoint (2026-10-12): [Development Status](Development%20Status.md) tracks the
reviewed PR #9 merge (`d51559cf`), [CI #21](https://github.com/ryukkfk/authcore/actions/runs/38075918583),
and development-only boundaries. The project's goals below include **planned**
capabilities; AUTH-001 registration, verification delivery and production readiness
are incomplete. Transactional signup audit (PR #7), restricted database
permissions (PR #8), and inactive Phase A idempotency ledger foundations (PR #9)
are integrated. `SIGNUP_ENABLED=false` remains the source default. The dated
PR #8 candidate evidence is archived in [Runtime Permissions Checkpoint](Runtime%20Permissions%20Checkpoint.md).

AuthCore is a production-oriented Identity and Access Management platform.

The goal of the project is to build a secure authentication and authorization system while learning production-grade backend architecture, application security, testing, observability, and infrastructure design.

## Core Goals

AuthCore will provide:

- user registration and authentication

- email verification

- secure session management

- password recovery

- multi-factor authentication

- device and session management

- organizations and memberships

- role-based access control

- audit logging

Later versions may include:

- OAuth 2.x

- OpenID Connect

- WebAuthn / Passkeys

- security risk detection

- suspicious login analysis

## Architecture Strategy

AuthCore will start as a modular monolith with a separate background worker.

The project will not begin as a microservices architecture.

Modules will maintain explicit boundaries so selected components can be extracted later if scale or operational requirements justify it.

## Security Principles

The system follows these principles:

- deny by default

- least privilege

- defense in depth

- secure defaults

- server-side authorization

- explicit trust boundaries

- auditable security-sensitive operations

- minimal secret exposure

## Initial Technology Direction

Frontend:

- Next.js

- TypeScript

Backend:

- NestJS

- TypeScript

Database:

- PostgreSQL

Cache and ephemeral state:

- Redis

Package manager:

- pnpm

Local infrastructure:

- Docker

Testing:

- unit tests

- integration tests

- end-to-end tests

- security regression tests

## Development Philosophy

Features must not be implemented without considering:

- security

- validation

- authorization

- logging

- testing

- failure behavior

- auditability

Correctness and security take priority over implementation speed.

## Related Documents

- [Security Defaults](Security%20Defaults.md) — loopback development bindings and default-disabled registration

- [Development Status](Development%20Status.md) — current milestone, latest verification, and next steps
- [Identity Foundation](Identity%20Foundation.md) — repository and transactional signup behavior
- [Architecture](Architecture.md)
- [Security Requirements](Security%20Requirements.md)
- [Threat Model](Threat%20Model.md)
- [Roadmap](Roadmap.md)
