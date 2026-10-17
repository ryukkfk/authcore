# AuthCore Security Requirements

Current development traceability (2026-10-17): [Security Test Matrix](Security%20Test%20Matrix.md)
maps SR-001–SR-050 to implemented slices, tests and unresolved requirements.
Local browser acceptance does not establish full requirement or release completion.

Stacked Phase B candidate (2026-10-15): [implementation and decisions](Phase%20B%20Implementation.md)
and [failure/threat evidence](Phase%20B%20Failure%20Matrix.md) document candidate controls
and remaining independent/operational gates. AUTH-001 is still incomplete and
`SIGNUP_ENABLED=false` remains the source default. No live migration or role adoption is implied.

Implementation checkpoint (2026-10-12): [Development Status](Development%20Status.md) documents PR #7,
PR #8 and PR #9 integrated at the reviewed `d51559cf` revision and successful
[CI #21](https://github.com/ryukkfk/authcore/actions/runs/38075918583).
This document states **requirements**, not proof of their complete implementation.
AUTH-001, independent security review, production readiness and live DB-role
adoption remain outstanding; `SIGNUP_ENABLED=false` is the source default.
Historical permission candidate evidence: [Runtime Permissions Checkpoint](Runtime%20Permissions%20Checkpoint.md).

Status: Active
Version: 0.1

This document defines mandatory security requirements for AuthCore.

Each requirement has a stable identifier so implementation, tests, and future security reviews can reference it directly.

---

## SR-001 — Password Storage

Passwords must never be stored in plaintext.

Passwords must never be reversibly encrypted for authentication.

Passwords must be processed using Argon2id through a maintained and reviewed library.

Password hashing parameters must be centrally configured.

Application modules must not directly choose arbitrary hashing parameters.

---

## SR-002 — Password Verification

Password verification must use the same approved password hashing implementation.

Authentication responses must not reveal whether the failure was caused by:

- unknown email
- unknown username
- incorrect password

Externally visible login errors should remain generic.

---

## SR-003 — Password Input Limits

Password endpoints must enforce explicit maximum input lengths.

This prevents unnecessary memory and CPU exhaustion during expensive password hashing.

The system must reject unreasonably large password payloads before invoking Argon2id.

---

## SR-004 — Session Credentials

Browser sessions must use opaque, cryptographically random session credentials.

Session credentials must not contain:

- user identifiers
- roles
- permissions
- email addresses
- tenant identifiers
- business data

Session credentials must be treated as secrets.

---

## SR-005 — Session Storage

Raw session credentials must never be persisted in PostgreSQL or Redis.

Only a deterministic cryptographic digest of the credential may be stored for lookup and verification.

Raw session credentials must never be written to logs.

---

## SR-006 — Browser Session Transport

Browser session credentials must be transmitted using cookies configured with:

- HttpOnly
- Secure in production
- an explicit SameSite policy
- an appropriate Path

Authentication credentials must not be stored in:

- localStorage
- sessionStorage
- IndexedDB

unless a future architecture decision explicitly changes this model.

---

## SR-007 — Session Expiration

Sessions must have explicit expiration policies.

The system must support:

- absolute expiration
- session revocation
- logout
- administrative revocation
- revocation after sensitive account events

Expired sessions must never be accepted.

---

## SR-008 — Session Rotation

Sessions must support rotation when required by security policy.

Examples include:

- privilege elevation
- sensitive reauthentication
- credential reset
- suspected compromise

Previously invalidated session credentials must not remain valid after rotation.

---

## SR-009 — HTTPS

Production traffic must use HTTPS.

Plain HTTP must not be used for authenticated production traffic.

Authentication cookies must use the Secure attribute in production.

---

## SR-010 — Server-Side Authorization

All authorization decisions must be enforced on the server.

Frontend logic may hide or disable UI elements, but this must never be treated as a security control.

A request must be denied if the backend cannot prove that the caller is authorized.

---

## SR-011 — Deny by Default

Authorization must follow a deny-by-default model.

If permission evaluation is incomplete, unknown, malformed, or unavailable, access must be denied.

---

## SR-012 — Tenant Isolation

Organization-owned resources must be associated with explicit tenant ownership where appropriate.

Tenant-scoped operations must include organization context.

A user from one organization must not be able to access another organization's resources without an explicitly permitted cross-tenant workflow.

---

## SR-013 — Cross-Tenant Testing

Tenant isolation must receive dedicated regression testing.

Security tests must cover at least:

- member of organization A cannot read organization B data
- member of organization A cannot update organization B data
- member of organization A cannot delete organization B data

---

## SR-014 — Role and Permission Enforcement

Roles must map to explicit permissions.

Business logic must not rely on role names alone when permission checks are sufficient.

Permission checks must occur before sensitive operations.

---

## SR-015 — Privilege Escalation Protection

Users must not be able to grant themselves privileges they do not already possess authority to grant.

Role assignment operations must validate:

- actor identity
- actor membership
- actor permissions
- target membership
- allowed role transitions

---

## SR-016 — Reauthentication

High-risk account operations must be able to require recent authentication.

Examples include:

- changing email
- changing password
- disabling MFA
- adding a new MFA method
- deleting an account
- generating recovery material
- rotating sensitive credentials

---

## SR-017 — Multi-Factor Authentication

MFA verification must occur server-side.

MFA challenges must have:

- expiration
- attempt limits
- replay protection
- explicit association with the relevant user/session

---

## SR-018 — Recovery Codes

Recovery codes must be generated using cryptographically secure randomness.

Plaintext recovery codes may only be shown at creation time.

Only secure hashes or equivalent one-way representations may be stored.

Recovery codes must be single-use.

---

## SR-019 — Password Reset Tokens

Password reset credentials must:

- use cryptographically secure randomness
- have explicit expiration
- be single-use
- be stored only in hashed or otherwise non-recoverable form

Successful password reset must invalidate the reset credential.

---

## SR-020 — Password Reset Session Policy

After a successful password reset, existing sessions must be reviewed according to security policy.

The system must support invalidating all active sessions after password reset.

---

## SR-021 — Email Verification Tokens

Email verification credentials must:

- be high entropy
- expire
- be single-use
- not be stored in plaintext

---

## SR-022 — Account Enumeration Resistance

Authentication and recovery flows must avoid unnecessary disclosure of account existence.

Examples:

Bad:

- "Email not found"
- "No account exists for this address"

Preferred:

- "Invalid credentials"
- "If an account exists, recovery instructions will be sent."

---

## SR-023 — Rate Limiting

Security-sensitive endpoints require dedicated rate limits.

Global API rate limiting alone is insufficient.

Rate limiting must be considered for:

- login
- password reset request
- password reset verification
- email verification resend
- MFA verification
- OAuth token endpoints later
- invitation endpoints where abuse is possible

---

## SR-024 — Multi-Dimensional Throttling

Authentication defenses should support multiple dimensions where appropriate.

Examples:

- per IP
- per account
- per device
- per challenge
- per client

This prevents trivial bypass of single-dimension limits.

---

## SR-025 — CSRF Protection

Cookie-authenticated state-changing browser requests must be protected against CSRF.

Controls may include:

- SameSite cookies
- Origin validation
- CSRF tokens where required

Security must not rely on SameSite alone without evaluating the endpoint threat model.

---

## SR-026 — XSS Resistance

The application must reduce the risk of script injection through:

- output escaping
- safe framework rendering
- controlled HTML rendering
- Content Security Policy
- avoiding JavaScript-readable authentication credentials

Raw HTML rendering must require explicit justification.

---

## SR-027 — SQL Injection Resistance

Database operations must use parameterized queries or safe ORM/query builder APIs.

Untrusted input must never be concatenated directly into SQL.

Input validation does not replace parameterized database access.

---

## SR-028 — Input Validation

All untrusted input must be validated at application boundaries.

Validation must cover:

- body
- query parameters
- path parameters
- headers where relevant

Invalid input must be rejected before reaching core business logic.

---

## SR-029 — Output Serialization

API responses must use explicit serialization rules.

Internal database objects must not be returned directly if they may expose:

- internal identifiers
- secrets
- hashes
- system metadata
- security-only fields

---

## SR-030 — Secret Management

Secrets must never be committed to Git.

Production secrets must come from an external secret management mechanism.

Examples:

- database credentials
- Redis credentials
- email provider keys
- signing private keys
- encryption keys
- OAuth client secrets

---

## SR-031 — Secret Exposure Minimization

Processes must receive only the secrets required for their function.

Example:

The web frontend must not receive database credentials.

A worker must not receive unrelated signing keys unless required.

---

## SR-032 — Cryptography

Custom cryptographic primitives are prohibited.

AuthCore must use established, maintained cryptographic libraries and standard algorithms.

Cryptographic choices must be documented.

---

## SR-033 — Encryption Keys

Recoverable sensitive data requiring encryption must use authenticated encryption.

Keys must be separated from ciphertext storage where practical.

Key rotation must be supported by design.

---

## SR-034 — Signing Keys

Future OAuth/OIDC signing keys must support:

- active keys
- key rotation
- verification of recently retired keys
- public JWKS exposure where applicable

Private keys must never be exposed through public endpoints.

---

## SR-035 — Audit Logging

Security-sensitive state changes must generate audit events.

Examples include:

- successful login
- failed login
- logout
- password changes
- password reset
- MFA enrollment
- MFA removal
- session revocation
- role changes
- membership changes
- OAuth client changes later

---

## SR-036 — Audit Data Safety

Audit logs must never contain:

- passwords
- raw session credentials
- access tokens
- refresh tokens
- authorization codes
- TOTP seeds
- recovery codes
- private cryptographic keys

---

## SR-037 — Audit Attribution

Audit events should capture sufficient attribution where appropriate.

Examples:

- actor ID
- target ID
- organization ID
- event type
- request ID
- timestamp
- relevant non-sensitive metadata

---

## SR-038 — Security Event Logging

Security-relevant failures should generate structured security events.

Examples:

- repeated login failures
- suspicious session use
- MFA failures
- authorization denials
- rate-limit triggers

---

## SR-039 — Error Disclosure

Public API responses must not expose:

- stack traces
- SQL statements
- filesystem paths
- internal hostnames
- raw exception details
- secret values

Internal diagnostics may be logged safely after redaction.

---

## SR-040 — Structured Logging

Application logs must use structured logging.

Logs should support fields such as:

- request ID
- trace ID
- endpoint
- status code
- duration
- non-sensitive user ID
- non-sensitive organization ID

Sensitive credentials must never be logged.

---

## SR-041 — Request Correlation

Incoming requests must eventually support a request identifier.

The identifier should propagate through:

- API logs
- worker jobs
- audit events
- error reporting

where practical.

---

## SR-042 — Background Job Safety

Security-sensitive background work must not rely on best-effort in-memory execution.

Important asynchronous work should use durable queueing or transactional outbox patterns.

---

## SR-043 — Transactional Consistency

Security-critical state changes that depend on event generation must avoid partial completion where practical.

Example:

If a password-reset record is created and a notification event must be queued, the system should avoid committing one without the other.

---

## SR-044 — Dependency Security

Security-sensitive dependencies must be:

- maintained
- necessary
- reviewed before introduction

Experimental or abandoned security libraries must not be used without explicit review.

---

## SR-045 — Database Exposure

Production PostgreSQL and Redis must not be directly exposed to the public internet.

Data services should use private network access wherever possible.

---

## SR-046 — Database Backup

Production PostgreSQL must support:

- regular backups
- restore testing
- point-in-time recovery where available
- encrypted storage

A backup is not considered reliable until restore procedures are validated.

---

## SR-047 — Security Regression Tests

Security bugs must receive regression tests where practical.

Previously fixed vulnerabilities must not be allowed to silently return.

---

## SR-048 — CI Verification

Changes should not be considered complete until required verification passes.

Current required CI for the implemented signup increment includes:

- linting and build
- type checking
- workspace unit/service tests
- PostgreSQL integration tests
- dedicated Redis integration tests
- combined HTTP/Redis/PostgreSQL end-to-end tests

[CI #21](https://github.com/ryukkfk/authcore/actions/runs/38075918583)
passed these suites for reviewed merge `d51559cf`. Passing CI is not
independent human security review or evidence that every SR requirement is met.
Security scanning will be added as the project matures.

---

## SR-049 — Production Access

Development agents and normal application processes must not receive unrestricted production access.

Production access must follow least privilege.

---

## SR-050 — Security Control Changes

Security controls must not be weakened solely to make development easier or tests pass.

Any intentional reduction in security must be documented through an architecture or security decision.
