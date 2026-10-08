# AuthCore Roadmap

Status: Active
Version: 0.1

Last updated: 2026-10-08 (Asia/Rangoon)

Current implementation progress and verification evidence: [[Development Status]].
The roadmap describes full ticket acceptance scope; implemented primitives do not
by themselves complete an entire registration or security milestone.

This roadmap defines the recommended implementation sequence for AuthCore.

The project should progress in small, reviewable increments.

Security-critical foundations must be completed before advanced identity features are added.

---

# Phase 0 — Foundation and Security Design

Goal:

Establish project structure, architecture rules, security requirements, development conventions, and local infrastructure.

## Deliverables

- Project Overview
- Architecture document
- Security Requirements
- Threat Model
- Roadmap
- AGENTS.md
- SECURITY.md
- README.md
- pnpm workspace
- TypeScript configuration
- ESLint
- test framework
- Docker Compose
- PostgreSQL
- Redis
- CI pipeline

## Tickets

### FOUNDATION-001 — Repository Structure

Create:

- apps/
- packages/
- docs/
- infrastructure/
- .github/

Status:

Implemented locally — repository directories are present.

---

### FOUNDATION-002 — Workspace Configuration

Add:

- pnpm workspace
- root package.json
- shared TypeScript configuration
- package scripts

Status:

Implemented locally — workspace build and typecheck passed at the 2026-10-08 checkpoint.

---

### FOUNDATION-003 — Linting and Formatting

Add:

- ESLint
- formatting rules
- shared lint configuration

Status:

Implemented with cleanup pending — workspace lint passed; whole-repository formatting
reported 73 pre-existing files at the 2026-10-08 checkpoint.

---

### FOUNDATION-004 — Test Infrastructure

Add:

- unit test framework
- shared test configuration
- test scripts

Status:

Implemented locally — unit and isolated PostgreSQL integration suites are available.
See [[Development Status]] for the latest API 33/33 and DB integration 14/14 checkpoint
and the limits on the inferred workspace/distinct totals.

---

### FOUNDATION-005 — Local Infrastructure

Add:

- PostgreSQL
- Redis
- Docker Compose
- health checks
- persistent development volumes

Status:

Configured — PostgreSQL and Redis services, health checks, and persistent volumes are
defined in Docker Compose. PostgreSQL was used successfully for the latest integration
tests; Redis runtime health was not checked in that checkpoint.

---

### FOUNDATION-006 — Environment Configuration

Add:

- environment schema validation
- .env.example
- development configuration loading

Status:

Implemented locally — validated configuration and API development environment loading
are present; environment configuration tests passed at the latest checkpoint.

---

### FOUNDATION-007 — CI Pipeline

CI must run:

- install
- lint
- typecheck
- tests
- build

Status:

Configured — GitHub Actions defines install, lint, build, typecheck, unit tests, and
PostgreSQL integration tests. Remote CI execution status is unverified here.

---

# Phase 1 — API and Database Foundation

Goal:

Create a minimal production-oriented backend foundation before authentication logic.

## Tickets

### API-001 — NestJS API Bootstrap

Add:

- NestJS
- application bootstrap
- global configuration
- health endpoint
- graceful shutdown

---

### API-002 — Request ID

Every request receives a unique request ID.

Request ID must propagate to structured logs.

---

### API-003 — Structured Logging

Add structured application logging.

Logs must follow [[Security Requirements]].

---

### API-004 — Global Error Handling

Create safe external API errors.

Never expose:

- stack traces
- raw exceptions
- SQL details
- secrets

---

### API-005 — Input Validation

Add centralized request validation.

Body, path, and query input must be validated.

---

### DB-001 — Database Package

Create `packages/db`.

Responsibilities:

- PostgreSQL client
- database schema
- migrations
- transaction support

---

### DB-002 — Migration Workflow

Create repeatable migration commands.

Rules:

- schema changes require migrations
- migrations must be versioned
- destructive migrations require review

---

### TEST-001 — Integration Database

Create isolated integration-test database setup.

---

# Phase 2 — Identity and Password Credentials

Goal:

Create the minimum user identity system.

## Tickets

### CRYPTO-001 — Password Hashing

Implement:

- Argon2id password hashing
- password verification
- centralized hashing configuration

Requirements:

- [[Security Requirements#SR-001 — Password Storage]]
- [[Security Requirements#SR-002 — Password Verification]]
- [[Security Requirements#SR-003 — Password Input Limits]]

Tests:

- correct password succeeds
- incorrect password fails
- malformed hash fails safely
- excessive password input rejected

---

### IDENTITY-001 — User Schema

Create:

- users
- user_emails

Important fields may include:

- public ID
- status
- timestamps

---

### IDENTITY-002 — Email Normalization

Define consistent email normalization rules.

Avoid unsafe assumptions about mailbox equivalence.

---

### AUTH-001 — Registration

Implement user registration.

Status: In progress — transactional signup foundation and signup HTTP boundary implemented
and locally verified on `feat/signup-foundation`. Foundation commit `45cf26a` is pushed;
HTTP endpoint edits remain uncommitted. See [[Identity Foundation]].

Implemented: public `POST /api/v1/auth/signup`, `SignupDto` email trim/validation,
12–128-character passwords with exact whitespace retained, and `AuthController` registration
in `IdentityModule`. Success and duplicate email return HTTP 202 `{"status":"accepted"}`;
invalid inputs/unexpected fields return 400 and unexpected failures receive safe 500 handling.
Coverage adds 3 controller unit tests and 7 HTTP integration tests.

Next: registration policy, verification-event creation/delivery, signup rate limiting and
abuse controls, timing-resistant account-enumeration protection, and durable audit.
Equal response status/body alone does not establish timing resistance. Registration is
incomplete and production deployment is not ready.

Naming note: the implementation conversation called signup foundation "API-004";
the original API-004 in this roadmap remains Global Error Handling. Track signup
foundation here under AUTH-001 without renumbering the original tickets.

Flow:

```
text
Request
  |
  v
Validate input
  |
  v
Check registration policy
  |
  v
Hash password
  |
  v
Create user + credential
  |
  v
Create verification event
```

# Phase 3 — Email Verification

Goal:

Verify control of user email addresses.

## Tickets

### VERIFY-001 — Verification Token Generation

Verification credentials must be:

- high entropy
- expiring
- single-use
- stored only in hashed form

---

### VERIFY-002 — Verification Endpoint

Implement verification consumption.

Security requirements:

- expired credential rejected
- consumed credential rejected
- invalid credential rejected

---

### NOTIFY-001 — Worker Foundation

Create background worker.

---

### NOTIFY-002 — Email Interface

Create provider-independent email interface.

Do not tightly couple core authentication logic to one email provider.

---

# Phase 4 — Login and Sessions

Goal:

Implement secure browser authentication.

## Tickets

### AUTH-002 — Login

Implement email/password login.

Security requirements:

- generic credential errors
- rate limiting
- audit events
- safe logging

---

### SESSION-001 — Session Schema

Create session persistence.

Session records must support:

- user ID
- token hash
- creation time
- expiration
- revocation
- last activity
- device metadata

---

### SESSION-002 — Secure Session Generation

Generate opaque random session credentials.

Store only the credential hash.

---

### SESSION-003 — Session Cookie

Configure browser session cookie.

Requirements:

- HttpOnly
- Secure in production
- SameSite policy
- explicit Path

---

### SESSION-004 — Authentication Middleware

Resolve session credential to authenticated user.

Expired and revoked sessions must fail.

---

### SESSION-005 — Logout

Revoke current session.

---

### SESSION-006 — Session Management

Allow users to:

- list sessions
- revoke one session
- revoke other sessions
- revoke all sessions

---

# Phase 5 — Password Recovery

Goal:

Implement secure account recovery.

## Tickets

### RECOVERY-001 — Reset Request

Implement password-reset request flow.

Must resist account enumeration.

---

### RECOVERY-002 — Reset Token

Reset credentials must be:

- high entropy
- expiring
- single-use
- hashed in storage

---

### RECOVERY-003 — Password Reset

After successful reset:

- credential is invalidated
- reset token is consumed
- sessions are revoked according to policy
- audit event is generated

---

# Phase 6 — Multi-Factor Authentication

Goal:

Add stronger authentication.

## Tickets

### MFA-001 — TOTP Enrollment

Implement TOTP setup.

---

### MFA-002 — TOTP Verification

Implement MFA challenge verification.

Must include:

- expiration
- attempt limits
- challenge binding

---

### MFA-003 — Recovery Codes

Generate secure single-use recovery codes.

Only hashed representations are stored.

---

### MFA-004 — MFA Removal

Disabling MFA must require recent strong authentication.

---

# Phase 7 — Organizations and Memberships

Goal:

Introduce multi-tenant organization support.

## Tickets

### ORG-001 — Organization Schema

Create organizations.

---

### ORG-002 — Membership Schema

Create organization memberships.

---

### ORG-003 — Organization Creation

Creator becomes initial privileged member.

---

### ORG-004 — Invitation System

Implement secure organization invitations.

---

### ORG-005 — Membership Removal

Add authorization and audit requirements.

---

# Phase 8 — Authorization

Goal:

Implement centralized permission enforcement.

## Tickets

### AUTHZ-001 — Permission Model

Define explicit permissions.

Example:

```
organization.read
organization.update
member.read
member.invite
member.remove
role.read
role.manage
audit.read
```

---

### AUTHZ-002 — Role Model

Map roles to permissions.

---

### AUTHZ-003 — Authorization Service

Create centralized authorization service.

---

### AUTHZ-004 — API Guards

Protected endpoints must enforce permissions server-side.

---

### AUTHZ-005 — Cross-Tenant Regression Tests

Required scenarios:

- org A cannot read org B
- org A cannot modify org B
- org A cannot delete org B
- membership ID manipulation fails

---

# Phase 9 — Audit System

Goal:

Provide reliable security attribution.

## Tickets

### AUDIT-001 — Audit Schema

Create append-oriented audit event storage.

---

### AUDIT-002 — Authentication Events

Record:

- login success
- login failure
- logout
- password reset
- session revocation

---

### AUDIT-003 — Authorization Events

Record:

- role assignment
- role removal
- invitation
- member removal
- privilege changes

---

### AUDIT-004 — Audit Viewer

Authorized organization administrators may inspect organization audit history.

---

# Phase 10 — Security Hardening

Goal:

Harden the completed V1 system before advanced features.

## Tickets

### SECURITY-001 — Authentication Rate Limits

Implement dedicated limits for:

- login
- reset
- verification
- MFA

---

### SECURITY-002 — CSRF Protection

Implement and test CSRF protections for cookie-authenticated state changes.

---

### SECURITY-003 — Security Headers

Add:

- Content-Security-Policy
- Strict-Transport-Security
- X-Content-Type-Options
- Referrer-Policy
- Permissions-Policy

---

### SECURITY-004 — Sensitive Log Redaction

Automated tests must verify known secret fields are never logged.

---

### SECURITY-005 — Dependency Scanning

Add CI dependency vulnerability scanning.

---

### SECURITY-006 — Secret Scanning

Add repository secret scanning.

---

### SECURITY-007 — Container Scanning

Add image vulnerability scanning when container builds are introduced.

---

### SECURITY-008 — Security Regression Suite

Create a dedicated regression suite for security invariants.

---

# Version 1 Release Gate

V1 must not be considered production-ready until all of the following are true:

- authentication works
- email verification works
- sessions are revocable
- password recovery works
- MFA works
- organizations work
- authorization works
- tenant-isolation tests pass
- audit logs exist
- rate limits exist
- CSRF protections exist
- logging is redacted
- CI is green
- database backup plan exists
- security documentation is current

---

# Phase 11 — OAuth 2.x

Begin only after V1 hardening.

Potential features:

- OAuth clients
- Authorization Code flow
- PKCE
- token endpoint
- token revocation
- consent management

OAuth requires a new threat-model review before implementation.

---

# Phase 12 — OpenID Connect

Potential features:

- discovery endpoint
- ID tokens
- userinfo
- JWKS
- signing-key rotation

---

# Phase 13 — WebAuthn and Passkeys

Potential features:

- passkey registration
- passkey authentication
- credential management
- device metadata

Threat model must be updated first.

---

# Phase 14 — Security Risk Engine

Initial implementation should be rule-based.

Signals may include:

- new device
- login failure velocity
- network changes
- unusual login behavior
- MFA failures

Possible responses:

- allow
- log
- require step-up authentication
- block

Machine learning is not required initially.

---

# Phase 15 — Production Operations

Add:

- production deployment automation
- managed PostgreSQL
- managed Redis
- secret manager
- monitoring
- alerting
- backup restore testing
- incident response procedures
- disaster recovery documentation

---

# Development Rule

Tickets should be implemented in dependency order.

Avoid implementing multiple security-critical systems simultaneously.

Preferred workflow:

```
Design
  ↓
Implement one ticket
  ↓
Unit tests
  ↓
Integration tests
  ↓
Security tests
  ↓
Review
  ↓
Commit
  ↓
Next ticket
```

---

# Current Position

Current milestone:

**Phase 2 — Identity and Password Credentials: signup HTTP boundary locally verified**

Current next work:

**AUTH-001 — Registration (in progress): registration policy and verification events,
with rate limiting, abuse controls, timing resistance, and durable audit still pending.**

Latest user-verified checkpoint: 2026-10-08, `feat/signup-foundation`, API 33/33
(including 4 signup PostgreSQL tests), separate DB integration 14/14, no skips;
workspace build, typecheck, and lint successful. Foundation commit `45cf26a` is pushed;
HTTP endpoint edits remain uncommitted. Production deployment is not ready.
See [[Development Status]] for the inferred 52 workspace / 66 distinct totals and evidence limits.
