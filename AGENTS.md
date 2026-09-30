# AuthCore Agent Instructions

AuthCore is a security-sensitive identity and access management platform.

Correctness, security, explicit boundaries, and maintainability are more important
than implementation speed.

## Architecture

AuthCore starts as a modular monolith with a separate background worker.

Applications:

- apps/web
- apps/api
- apps/worker

Shared packages:

- packages/db
- packages/contracts
- packages/config
- packages/crypto
- packages/observability
- packages/testing

Do not introduce microservices without an explicit Architecture Decision Record.

## Security Rules

The following rules are mandatory.

1. Never implement custom cryptographic primitives.
2. Never store plaintext passwords.
3. Never log passwords, session tokens, access tokens, refresh tokens,
   authorization codes, TOTP secrets, recovery codes, or private keys.
4. Never store browser authentication tokens in localStorage.
5. Authentication authorization must always be enforced server-side.
6. Frontend authorization checks are presentation only.
7. All tenant-scoped access must explicitly include organization scope.
8. Security-sensitive state changes must emit audit events.
9. Raw session tokens must never be stored in the database.
10. Database changes require migrations.
11. API input must be validated before reaching business logic.
12. Secrets must never be committed to Git.
13. Error responses must not expose stack traces or internal infrastructure.
14. Security controls must never be disabled merely to make tests pass.
15. New security behavior requires security regression tests.

## Dependency Rules

Before adding a dependency:

- verify that it is necessary
- prefer maintained and established packages
- avoid duplicate libraries solving the same problem
- never add experimental crypto/security libraries without explicit approval

## Module Boundaries

A module must not directly mutate another module's persistence layer.

Bad:

organization module -> directly modifies role tables

Good:

organization module -> authorization service -> role mutation

Cross-module behavior must go through exported application/domain interfaces.

## Database Rules

- PostgreSQL is the source of truth.
- Redis must not contain canonical user or authorization data.
- IDs exposed externally must not be predictable sequential identifiers.
- Foreign keys must be used where appropriate.
- Destructive migrations require explicit review.

## API Rules

Every endpoint must define:

- authentication requirement
- authorization requirement
- validated input
- validated/serialized output
- expected error codes
- rate-limit category
- audit behavior where relevant

## Logging Rules

Structured logs are required.

Logs may contain:

- request ID
- trace ID
- endpoint
- HTTP status
- timing
- non-sensitive user ID
- non-sensitive organization ID

Logs must never contain credentials or authentication secrets.

## Testing

Before completing a task, run:

1. pnpm lint
2. pnpm typecheck
3. pnpm test
4. relevant integration tests
5. relevant E2E tests when available

Tests must not be deleted or weakened just to make a change pass.

## Scope Discipline

Implement only the requested ticket.

Do not:

- refactor unrelated modules
- silently change public APIs
- introduce infrastructure unrelated to the ticket
- add speculative abstractions