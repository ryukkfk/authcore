# AuthCore Architecture

## Overview

AuthCore is a production-oriented Identity and Access Management platform.

The initial architecture uses a modular monolith with a separate background worker.

The goal is to keep the system operationally simple while preserving strong module boundaries so selected components can be extracted into independent services later if justified by scale or ownership requirements.

---

## High-Level Architecture

```text
                        Internet
                           |
                           v
                 +-------------------+
                 | CDN / WAF / TLS   |
                 +---------+---------+
                           |
                           v
                 +-------------------+
                 | Reverse Proxy     |
                 | Rate Limiting     |
                 | Security Headers  |
                 +---------+---------+
                           |
             +-------------+-------------+
             |                           |
             v                           v
     +---------------+           +---------------+
     | Web App       |           | Public Auth   |
     | Next.js       |           | Endpoints     |
     +-------+-------+           +-------+-------+
             |                           |
             +-------------+-------------+
                           |
                           v
                +------------------------+
                | AuthCore API           |
                | Modular Monolith       |
                +------------------------+
                | Identity               |
                | Authentication         |
                | Sessions               |
                | MFA                    |
                | Organizations          |
                | Authorization          |
                | Audit                  |
                | OAuth / OIDC later     |
                | Risk Engine later      |
                +-----+---------+--------+
                      |         |
                      |         |
              +-------+         +---------+
              v                           v
       +-------------+             +-------------+
       | PostgreSQL  |             | Redis       |
       | Source of   |             | Ephemeral   |
       | Truth       |             | State       |
       +------+------+             +-------------+
              |
              |
              v
       +-------------+
       | Outbox      |
       | Events      |
       +------+------+
              |
              v
       +-------------+
       | Worker      |
       | Email       |
       | Cleanup     |
       | Audit Jobs  |
       +-------------+
```

---

## Architectural Style

AuthCore starts as a modular monolith.

This means:

- one primary API deployment
- one primary relational database
- explicit internal modules
- a separate worker process
- no unnecessary network boundaries between internal domains

This architecture is chosen because distributed systems introduce additional security and operational complexity.

Microservices will only be introduced when there is a concrete reason such as:

- independent scaling
- independent deployment requirements
- distinct ownership
- security isolation
- operational bottlenecks

---

## Core Runtime Components

### Web Application

Responsibilities:

- authentication UI
- account management UI
- organization management UI
- session/device management UI
- MFA enrollment UI
- administrative UI

The web application must not be trusted for authorization decisions.

All authorization must be enforced by the backend.

---

## API Application

The API is the primary application boundary.

Responsibilities:

- authentication
- authorization
- validation
- session management
- organization management
- audit generation
- business logic
- persistence orchestration

The API must treat all external input as untrusted.

---

## Worker

The worker handles asynchronous and background operations.

Examples:

- email delivery
- verification email processing
- password reset email processing
- audit export
- expired token cleanup
- session cleanup
- scheduled security jobs
- webhook delivery later

Background operations must use durable jobs where data loss would be unacceptable.

---

## PostgreSQL

PostgreSQL is the source of truth for persistent application state.

Examples:

- users
- credentials
- sessions
- organizations
- memberships
- roles
- permissions
- OAuth clients
- audit events
- security events

Redis must never replace PostgreSQL as the canonical source of authorization or identity state.

---

## Redis

Redis is used for ephemeral or performance-sensitive state.

Examples:

- rate limits
- temporary challenges
- short-lived verification state
- queue backend
- cache
- distributed locks

Redis must not contain the only copy of important identity or authorization data.

---

## Module Boundaries

The initial API contains the following modules.

```
identity/
authentication/
sessions/
mfa/
organizations/
authorization/
audit/
notifications/

future:
oauth/
oidc/
webauthn/
security-risk/
```

Each module owns its own domain behavior.

A module must not directly manipulate another module's persistence model.

Example:

```
BAD

OrganizationsModule
    |
    +--> directly writes role tables


GOOD

OrganizationsModule
    |
    +--> AuthorizationService
              |
              +--> role persistence
```

---

## Trust Boundaries

AuthCore uses explicit trust zones.

### Zone 1 - Untrusted

Includes:

- browsers
- mobile clients
- internet clients
- third-party OAuth clients

Everything from this zone is considered untrusted.

---

### Zone 2 - Edge

Includes:

- CDN
- WAF
- TLS termination
- reverse proxy
- request rate limiting

Responsibilities:

- reject obviously malicious traffic
- enforce TLS
- apply edge rate limits
- attach request metadata where appropriate

The edge does not replace application-level security.

---

### Zone 3 - Application

Includes:

- API
- worker

Responsibilities:

- authentication
- authorization
- validation
- business logic
- audit generation

---

### Zone 4 - Data

Includes:

- PostgreSQL
- Redis
- secret management system
- cryptographic key management system

This zone must not be directly reachable from the public internet.

---

## Request Flow

A normal protected API request follows this pipeline:

```
Incoming Request
      |
      v
Request ID
      |
      v
Security Headers
      |
      v
Body Size Limits
      |
      v
Rate Limiting
      |
      v
Input Validation
      |
      v
Authentication
      |
      v
Tenant Context
      |
      v
Authorization
      |
      v
Business Logic
      |
      v
Audit Event
      |
      v
Response Serialization
```

Security-sensitive requests must not bypass required stages.

---

## Authentication Boundary

Authentication answers:

"Who is this user?"

Authentication mechanisms may include:

- password
- MFA
- passkey
- OAuth authentication later

Authentication alone does not grant permission to resources.

---

## Authorization Boundary

Authorization answers:

"Is this authenticated identity allowed to perform this action on this resource?"

Authorization must:

- run server-side
- consider organization context
- use explicit permissions
- deny by default

Frontend visibility checks are not security controls.

---

## Tenant Isolation

Organization-owned resources must be tenant scoped.

Example:

```
resource.organization_id == currentOrganization.id
```

Authorization must verify membership and required permissions before resource access.

Cross-tenant access must receive dedicated security regression tests.

---

## Session Architecture

Browser sessions will use opaque random session credentials.

The browser receives the credential in a secure HttpOnly cookie.

The database stores only a cryptographic digest of the session credential.

```
Browser
   |
   | raw opaque session credential
   v
HTTPS Cookie
   |
   v
API
   |
   | hash credential
   v
Session Store
```

Raw session credentials must not be stored in the database or logs.

---

## Background Event Pattern

AuthCore will use the transactional outbox pattern for important asynchronous work.

Example:

```
Database Transaction
      |
      +--> user created
      |
      +--> outbox event created
                |
                v
              Worker
                |
                v
         verification email
```

This prevents state changes from succeeding while important background events are silently lost.

---

## Observability

Every request should eventually support:

- request ID
- trace ID
- route
- status code
- duration
- non-sensitive user identifier
- non-sensitive organization identifier

Sensitive credentials must never be logged.

---

## Deployment Strategy

Current development defaults use loopback API/Compose bindings and a default-disabled
signup HTTP guard. See [[Security Defaults]]. The diagram and production topology
below describe the target architecture, not a verified active deployment.

Initial production deployment:

```
CDN / WAF
    |
Load Balancer
    |
+---------+---------+
|                   |
API Instance 1   API Instance 2
|                   |
+---------+---------+
          |
    +-----+-----+
    |           |
PostgreSQL    Redis
    |
  Worker
```

PostgreSQL should use:

- private networking
- encrypted storage
- backups
- point-in-time recovery

---

## Evolution Strategy

AuthCore should evolve only when justified.

### Stage 1

```
Modular Monolith
+
Worker
```

### Stage 2

Potential independent workers:

- audit processing
- notification processing

### Stage 3

Possible service extraction:

- OAuth/OIDC
- audit
- risk analysis

### Stage 4

Only at substantial scale:

- identity service
- authorization service
- OAuth service
- risk service
- audit service

Architecture must evolve from measured requirements, not speculation.

---

## Non-Goals for Version 1

Version 1 will not include:

- Kubernetes
- Kafka
- service mesh
- custom cryptographic algorithms
- machine-learning risk detection
- complex microservices
- multi-region active-active architecture

These may be considered later if justified.

---

## Architecture Principles

1. Security before convenience.
2. Deny by default.
3. PostgreSQL is the source of truth.
4. Redis stores ephemeral state only.
5. Authorization is server-side.
6. Trust boundaries must be explicit.
7. Modules communicate through defined interfaces.
8. Security-sensitive operations must be auditable.
9. Distributed complexity must be justified.
10. Architecture should remain understandable by one engineer.

## Related Security Documents

- [[Security Requirements]]
- [[Threat Model]]
