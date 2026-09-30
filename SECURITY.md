# AuthCore Security Policy

AuthCore is an identity and access management platform and must be treated as
security-sensitive software.

## Security Principles

AuthCore follows these principles:

- deny by default
- least privilege
- defense in depth
- explicit trust boundaries
- secure defaults
- server-side authorization
- auditable security-sensitive actions
- minimal secret exposure
- short-lived credentials where appropriate

## Sensitive Data

The following data must never appear in logs:

- passwords
- plaintext recovery codes
- session tokens
- access tokens
- refresh tokens
- OAuth authorization codes
- TOTP seeds
- signing private keys
- encryption keys

## Password Handling

Passwords must be processed using a vetted password hashing implementation.

Password hashing configuration must be centrally owned by the crypto package.

Application modules must not directly implement password hashing.

## Session Handling

Browser authentication uses secure, opaque sessions.

Raw session credentials must never be persisted.

Session credentials must be transported only through secure HTTP mechanisms.

## Authorization

All authorization decisions must be made server-side.

A UI hiding a button or route does not constitute authorization.

Tenant-scoped access must validate organization membership and permissions.

## Cryptography

Custom cryptographic algorithms are prohibited.

Keys and algorithms must be versionable and rotatable.

Production private keys and encryption keys must not be stored in the repository.

## Reporting Security Problems

Until a dedicated security reporting channel exists, security findings must not
be posted publicly.

Document:

- affected component
- reproduction conditions
- impact
- proposed mitigation if known