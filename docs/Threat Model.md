# AuthCore Threat Model

M2 resend adds an unauthenticated email-trigger surface. Dedicated HMAC-bound
IP/address/global Redis limits precede database work; account-row serialization
and database cooldown/rolling cap independently bound issuance. Unknown, verified,
disabled and policy-limited addresses share generic acceptance. Existing proofs
remain valid so a forged request cannot invalidate an owner's link. Requests that
cause issuance append correlated intent/audit in the same transaction. See
[Registration and Verification Policy](Registration%20and%20Verification%20Policy.md)
for exact limits, error contract and remaining timing/retention boundaries.

Local browser candidate (2026-10-17) adds the following scoped boundaries. These
supplement, rather than supersede, the Phase B transaction/driver threat evidence.

| Threat                                     | Current mitigation and evidence                                                                                                                                              | Remaining boundary                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Forged browser authentication              | Actual server Argon2 proof and verified/enabled account state; hash-only revocable sessions; real SQL/Redis/HTTP/browser tests                                               | MFA/reauthentication and account recovery pending                      |
| CSRF/session theft/replay                  | Exact Origin/custom-header policy, HttpOnly/SameSite cookies, bounded bodies, rotation/DB expiry/revocation; browser logout replay returns 401                               | Production TLS/proxy review and XSS assessment remain necessary        |
| Mail verification proof disclosure         | URL fragment removed before client requests/rendering; no analytics/storage; explicit consumption; hashed verifier proof; encrypted durable retry payload                    | Local mailbox and private files are trusted development infrastructure |
| Cookie sharing across local ports          | Development Path `/api/v1/auth` excludes ordinary Mailpit `/api/v1` requests; browser checks cookie path and storage                                                         | Ports do not isolate cookies; do not colocate untrusted local services |
| XSS/CSP relaxation during restart          | React escaping, no raw HTML sink, strict script CSP; demo HMR/WebSocket disabled; browser observes zero CSP errors                                                           | Production hosting headers require separate validation                 |
| Accidental production/default signup       | Explicit development flags/entry, literal loopback targets and disposable database/role names, independently provisioned HMAC metadata/immutable anchor                      | Public signup and live credentials/roles remain separately gated       |
| Lost worker event or startup/shutdown race | Durable transactional outbox; independent worker retries/leases; supervisor retains process ownership through IPC readiness and actual drain; restart and startup-stop tests | Single local PostgreSQL does not establish primary/failover durability |

See [Security Test Matrix](Security%20Test%20Matrix.md) for requirement-specific
coverage and gaps. No local test establishes external certification or production
readiness; tenant isolation remains unimplemented until organization/RBAC work.

Stacked Phase B candidate (2026-10-15): [implementation threat/failure evidence](Phase%20B%20Failure%20Matrix.md)
maps T01–T17 and F01–F28, distinguishing real/synthetic tests from operational gates.
The historical baseline below is not independent approval of this candidate.

Implementation checkpoint (2026-10-12): this model includes **planned** controls.
PR #7 implemented transactional signup audit, PR #8 merged restricted-role
provisioning, and PR #9 merged inactive Phase A idempotency ledger primitives.
The reviewed `main` revision `d51559cf` passed [CI #21](https://github.com/ryukkfk/authcore/actions/runs/38075918583).
Public signup remains disabled by default; full registration and security
review are incomplete. See [Development Status](Development%20Status.md) and the historical
[Runtime Permissions Checkpoint](Runtime%20Permissions%20Checkpoint.md).

Status: Active
Version: 0.1

This document identifies important assets, trust boundaries, attack surfaces,
threats, and mitigations for AuthCore.

The threat model is expected to evolve as the architecture and feature set grow.

---

# 1. Security Objectives

AuthCore must protect:

- identity integrity
- authentication integrity
- authorization correctness
- session confidentiality
- tenant isolation
- credential confidentiality
- audit integrity
- cryptographic key confidentiality
- service availability

The system must assume all internet-facing input is hostile until validated.

---

# 2. Assets

## 2.1 User Identity Data

Examples:

- user ID
- email address
- account state
- profile metadata

Security goals:

- confidentiality
- integrity
- correct ownership

---

## 2.2 Password Credentials

Examples:

- password hashes
- hashing metadata

Security goals:

- plaintext passwords must never be stored
- hashes must resist offline cracking
- hashing configuration must be centrally controlled

---

## 2.3 Session Credentials

Examples:

- browser session tokens
- session records
- session metadata

Security goals:

- raw session tokens remain secret
- stolen or expired sessions can be revoked
- session use can be audited

---

## 2.4 MFA Material

Examples:

- TOTP secrets
- recovery codes
- MFA enrollment state

Security goals:

- secrets are not exposed
- recovery codes are single-use
- MFA state cannot be silently downgraded

---

## 2.5 Authorization State

Examples:

- organization memberships
- roles
- permissions
- ownership relationships

Security goals:

- prevent privilege escalation
- enforce tenant isolation
- preserve authorization integrity

---

## 2.6 OAuth/OIDC Credentials

Future assets include:

- OAuth client secrets
- authorization codes
- access tokens
- refresh tokens
- signing keys

Security goals:

- confidentiality
- integrity
- replay resistance
- safe rotation

---

## 2.7 Audit Events

Examples:

- login events
- permission changes
- session revocations
- security events

Security goals:

- reliable attribution
- minimal tampering
- no credential leakage

---

## 2.8 Cryptographic Keys

Examples:

- signing private keys
- encryption keys
- key-encryption keys

Security goals:

- confidentiality
- controlled access
- rotation
- separation from application data

---

# 3. Actors

## 3.1 Legitimate User

A normal authenticated user.

Possible risks:

- compromised account
- accidental privilege misuse
- malicious insider behavior

---

## 3.2 Organization Administrator

A user with elevated organization permissions.

Possible risks:

- abuse of administrative authority
- account compromise
- excessive privilege

---

## 3.3 Anonymous Internet Attacker

An unauthenticated attacker targeting public endpoints.

Capabilities may include:

- automated requests
- credential stuffing
- brute force
- malformed inputs
- enumeration attempts
- denial-of-service attempts

---

## 3.4 Authenticated Malicious User

A legitimate user attempting unauthorized access.

Examples:

- cross-tenant access
- privilege escalation
- IDOR/BOLA attacks
- role manipulation

---

## 3.5 Compromised Client

A browser or device controlled by an attacker.

Possible capabilities:

- stolen cookies
- malicious extensions
- script execution
- replay attempts

---

## 3.6 Compromised Dependency

A malicious or vulnerable third-party package.

Risks:

- credential theft
- supply-chain compromise
- arbitrary code execution

---

## 3.7 Compromised Infrastructure Credential

An attacker obtains:

- database credentials
- cloud API credentials
- secret-manager credentials

Impact may be severe depending on privilege.

---

# 4. Trust Zones

## Zone 1 — Untrusted

Includes:

- browsers
- external clients
- third-party applications
- public internet traffic

Trust level:

None.

All input must be validated.

---

## Zone 2 — Edge

Includes:

- CDN
- WAF
- reverse proxy
- TLS termination
- coarse rate limiting

Trust level:

Limited.

The application must not assume traffic is safe because it passed the edge layer.

---

## Zone 3 — Application

Includes:

- AuthCore API
- background worker

Trust level:

Controlled but not absolute.

Application code must enforce authentication, authorization, and validation.

---

## Zone 4 — Data

Includes:

- PostgreSQL
- Redis
- queue storage
- object storage where applicable

Trust level:

Restricted.

Data systems must not be publicly exposed.

---

## Zone 5 — Secrets and Key Management

Includes:

- cloud secret manager
- KMS/HSM later
- signing keys
- encryption keys

Trust level:

Highly restricted.

Only explicitly authorized workloads may access this zone.

---

# 5. Major Trust Boundaries

## TB-001 — Internet to Edge

Threats:

- malformed traffic
- denial of service
- scanning
- bot activity

Controls:

- TLS
- WAF
- edge rate limiting
- request size limits

---

## TB-002 — Edge to Application

Threats:

- spoofed headers
- malicious payloads
- bypass of edge assumptions

Controls:

- server-side validation
- authentication
- authorization
- trusted proxy configuration

---

## TB-003 — Application to PostgreSQL

Threats:

- SQL injection
- excessive DB privilege
- data exfiltration
- accidental cross-tenant access

Controls:

- parameterized queries
- least-privilege DB role
- tenant-scoped queries
- private networking

---

## TB-004 — Application to Redis

Threats:

- poisoned cache
- unauthorized state manipulation
- accidental use as canonical storage

Controls:

- restricted access
- private networking
- limited data responsibilities
- no authoritative identity data

---

## TB-005 — Application to Secret Management

Threats:

- broad secret access
- secret leakage
- compromised runtime

Controls:

- least privilege
- workload-specific secret access
- rotation
- auditing

---

# 6. Attack Surface

## Public Authentication Endpoints

Examples:

- register
- login
- logout
- password reset
- email verification
- MFA verification

High-value targets because they are publicly reachable and process credentials.

---

## Organization APIs

Examples:

- membership management
- role assignment
- invitations
- organization settings

High-risk because authorization failures can cause tenant compromise.

---

## Session APIs

Examples:

- list sessions
- revoke session
- revoke all sessions

High-risk because session controls affect account security.

---

## Administrative Interfaces

Future admin interfaces may expose:

- security events
- user controls
- tenant configuration

Administrative actions require strong authorization and audit coverage.

---

## Background Worker

Risks include:

- malicious job payloads
- secret overexposure
- unsafe retries
- duplicate processing

---

## Database Layer

Risks include:

- injection
- privilege abuse
- unsafe migrations
- unencrypted backups
- cross-tenant query mistakes

---

# 7. STRIDE Threat Analysis

# 7.1 Spoofing

## T-S-001 — Credential Stuffing

Attack:

An attacker uses username/password pairs leaked from unrelated systems.

Impact:

- account takeover
- session creation
- organization compromise

Controls:

- SR-001 password hashing
- SR-023 rate limiting
- SR-024 multi-dimensional throttling
- MFA
- passkeys later
- suspicious-login detection later

Required tests:

- repeated login failures trigger throttling
- per-account protection exists
- generic error responses are maintained

---

## T-S-002 — Brute Force Password Guessing

Attack:

An attacker repeatedly guesses passwords for a known account.

Controls:

- expensive password hashing
- account/IP throttling
- MFA
- security event logging

---

## T-S-003 — Session Credential Theft

Attack:

An attacker obtains a valid session cookie.

Possible sources:

- compromised browser
- XSS
- malware
- unsafe logging
- network misconfiguration

Controls:

- HttpOnly
- Secure
- SameSite
- HTTPS
- session expiration
- revocation
- step-up authentication

---

## T-S-004 — MFA Challenge Theft or Replay

Attack:

An attacker reuses or steals MFA challenge state.

Controls:

- short expiration
- attempt limits
- challenge binding
- replay protection

---

# 7.2 Tampering

## T-T-001 — Role Manipulation

Attack:

A user alters a request to assign themselves an elevated role.

Impact:

Privilege escalation.

Controls:

- server-side authorization
- role transition validation
- audit logging
- deny by default

Required tests:

- normal member cannot assign admin role
- admin cannot exceed allowed delegation
- unauthorized role update returns denial

---

## T-T-002 — Cross-Tenant Resource Manipulation

Attack:

A user changes an organization/resource ID to access another tenant.

Example:

```text
PATCH /organizations/org_B/members/123
```

while authenticated only to `org_A`.

Controls:

- tenant context
- resource ownership checks
- organization-scoped queries
- authorization regression tests

---

## T-T-003 — Password Reset Token Replay

Attack:

A reset credential is used more than once.

Controls:

- single-use reset tokens
- transactionally mark consumed
- expiration
- session invalidation policy

---

## T-T-004 — Audit Log Modification

Attack:

An attacker modifies or removes audit evidence.

Controls:

- restricted write paths
- no ordinary edit/delete API
- database permissions
- append-oriented design
- later integrity chaining/export

Current implementation boundary: restricted-role provisioning merged in PR #8
and expanded for two Phase A idempotency tables in PR #9. Tests reject mutation
of existing audit rows by that restricted principal, but database owners and
superusers retain broader powers; direct INSERT may control new event values.
No integrity chaining/export, tamper-evidence guarantee or live-role adoption is
established. Phase A does not implement HTTP Idempotency-Key enforcement,
uncertain COMMIT result recovery or a live HMAC rotation protocol. Retention and
account-deletion policies remain unresolved. See [Development Status](Development%20Status.md).

---

# 7.3 Repudiation

## T-R-001 — Administrative Action Denial

Scenario:

An administrator changes another user's role and later denies performing the action.

Controls:

- actor ID
- target ID
- organization ID
- request ID
- timestamp
- event type
- relevant metadata

---

## T-R-002 — Session Revocation Dispute

Scenario:

A user or administrator disputes whether a session was revoked.

Controls:

- structured audit event
- timestamp
- actor attribution
- session identifier metadata

---

# 7.4 Information Disclosure

## T-I-001 — Password Disclosure

Attack:

Passwords leak through:

- logs
- debug output
- database
- error reporting

Controls:

- never log password data
- one-way password hashing
- log redaction
- no sensitive exception payloads

---

## T-I-002 — Session Token Disclosure

Attack:

Raw session token appears in:

- logs
- analytics
- database
- application error output

Controls:

- hash session credentials before persistence
- logging redaction
- secure cookies

---

## T-I-003 — Account Enumeration

Attack:

An attacker determines valid accounts through response differences.

Controls:

- generic login errors
- generic password-reset responses
- consistent status behavior where practical

---

## T-I-004 — Cross-Tenant Data Leakage

Attack:

A user reads another organization's data.

Impact:

Potentially critical.

Controls:

- explicit tenant scope
- authorization checks
- regression tests
- later database RLS as defense in depth

---

## T-I-005 — Secret Leakage

Attack:

Secrets are exposed through:

- source control
- logs
- build artifacts
- frontend bundles
- environment dumps

Controls:

- external secret management
- `.gitignore`
- secret scanning
- runtime access controls
- frontend/server separation

---

# 7.5 Denial of Service

## T-D-001 — Password Hashing Exhaustion

Attack:

Large volumes of password attempts consume CPU and memory due to Argon2id work.

Controls:

- request throttling
- input size limits
- edge protection
- bounded worker resources

---

## T-D-002 — Oversized Request Payload

Attack:

An attacker sends very large request bodies.

Controls:

- body size limits
- reverse proxy limits
- endpoint-specific limits

---

## T-D-003 — Email Abuse

Attack:

An attacker repeatedly triggers:

- verification emails
- password reset emails
- invitations

Controls:

- endpoint rate limiting
- per-account limits
- per-IP limits
- queue protections

---

## T-D-004 — Queue Flooding

Attack:

Large numbers of requests produce excessive background jobs.

Controls:

- input throttling
- queue capacity controls
- job deduplication where appropriate
- worker concurrency limits

---

# 7.6 Elevation of Privilege

## T-E-001 — Member to Admin Escalation

Attack:

A normal member attempts to gain an administrator role.

Controls:

- explicit permission checks
- allowed transition rules
- server-side enforcement
- audit logs

---

## T-E-002 — Organization A to Organization B Escalation

Attack:

A user uses valid authentication but changes tenant context.

Controls:

- membership verification
- tenant-scoped authorization
- resource ownership validation

---

## T-E-003 — Frontend Authorization Bypass

Attack:

A user manually calls an endpoint hidden by the UI.

Controls:

- backend authorization on every protected action

Frontend visibility must never be treated as authorization.

---

## T-E-004 — Stale Permission Use

Attack:

A user continues using privileges after their role is removed.

Controls:

- authorization against current server-side state
- appropriate cache invalidation
- session/permission refresh policy

---

# 8. High-Risk Security Scenarios

The following scenarios are treated as especially important.

## HR-001 Cross-Tenant Access

Severity:

Critical

Security invariant:

> A user must never access another organization's private resources without an explicitly authorized workflow.

---

## HR-002 Privilege Escalation

Severity:

Critical

Security invariant:

> A user must never grant themselves privileges they are not authorized to grant.

---

## HR-003 Session Theft

Severity:

High

Security invariant:

> A compromised session must be revocable and must not expose long-lived reusable credentials unnecessarily.

---

## HR-004 Password Reset Abuse

Severity:

High

Security invariant:

> Password recovery must not become an easier authentication path than normal login.

---

## HR-005 Secret Leakage

Severity:

Critical

Security invariant:

> Production secrets and private cryptographic keys must never reach public source control, frontend code, or application logs.

---

# 9. Security Invariants

These invariants must remain true regardless of implementation details.

## INV-001

Passwords are never stored in plaintext.

## INV-002

Raw browser session credentials are never stored in the database.

## INV-003

Authorization is enforced server-side.

## INV-004

Tenant-owned resources cannot cross tenant boundaries without explicit authorization.

## INV-005

Security-sensitive state changes are auditable.

## INV-006

Authentication secrets are never written to logs.

## INV-007

Invalid or ambiguous authorization state results in denial.

## INV-008

Recovery credentials are expiring and single-use.

## INV-009

Production secrets are not committed to the repository.

## INV-010

Security controls are not disabled merely to make development easier.

---

# 10. Threat-to-Requirement Mapping

| Threat                   | Primary Requirements           |
| ------------------------ | ------------------------------ |
| Credential stuffing      | SR-001, SR-023, SR-024         |
| Brute force              | SR-003, SR-023, SR-024         |
| Session theft            | SR-004, SR-005, SR-006, SR-007 |
| Account enumeration      | SR-022                         |
| Cross-tenant access      | SR-010, SR-011, SR-012, SR-013 |
| Privilege escalation     | SR-014, SR-015                 |
| MFA replay               | SR-017                         |
| Recovery-code abuse      | SR-018                         |
| Password-reset abuse     | SR-019, SR-020                 |
| CSRF                     | SR-025                         |
| XSS                      | SR-026                         |
| SQL injection            | SR-027                         |
| Secret leakage           | SR-030, SR-031                 |
| Audit tampering          | SR-035, SR-036, SR-037         |
| Sensitive error leakage  | SR-039                         |
| DoS via password hashing | SR-003, SR-023, SR-024         |

---

# 11. Future Threat Modeling Work

The threat model must be expanded when adding:

- OAuth 2.x
- OpenID Connect
- passkeys/WebAuthn
- API keys
- machine-to-machine authentication
- webhooks
- billing
- external identity providers
- admin support tooling
- mobile applications
- multi-region deployment

Each major architectural change must trigger a threat-model review.
