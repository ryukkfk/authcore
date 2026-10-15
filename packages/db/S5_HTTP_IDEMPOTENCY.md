# S5 HTTP Idempotency-Key development contract

This implementation is inactive by default: `SIGNUP_ENABLED=false`. AUTH-001 remains
incomplete. No deployment, live migration, privilege change, secret creation or public
activation is performed. Independent human security review is pending.

## Startup and writer boundary

`SignupService` is now a facade over the S4 keyed protocol. No unkeyed production writer
or controller duplicate-error shortcut remains. The old Phase A implementation is an
explicit historical `signup-phase-a.test-support.ts` fixture, excluded from production
builds; its original assertions remain historical regressions, not Phase B evidence.

Disabled startup accesses neither secret configuration nor PostgreSQL. Enabled startup
requires explicitly injected `SIGNUP_CONFIGURATION`: dedicated32-byte material,
independently approved HMAC version/KAT metadata and an explicit1..86400000ms execution
window. The S2 boundary validates attestation against the retained namespace before
listening. `IdentityModule.withSignup` is an explicit composition API; it does not set
the flag. The default AppModule supplies no secret. Setting only the flag fails closed.
No environment secret guessing, fallback, implicit rotation or namespace creation.

## Processing order

1. Transport budgets and uncompressed UTF-8 JSON parsing.
2. Startup-snapshotted disabled guard (routable requests still return403).
3. Existing real socket-address Redis rate limits:5/IP/10min,30global/min.
4. Mandatory key guard using complete Node `rawHeaders`, before admission.
5. Local/distributed admission; shallow object/string checks prevent recursive DTO
   transformation while preserving rate/admission-before-DTO order.
6. Existing Unicode DTO validation, frozen v1 binding, T1, hashing, T2 and bounded T3.

Exactly one case-insensitive header line is required. Value length16..128, characters
only `[A-Za-z0-9_-]`; no comma, quotes, Unicode, embedded spaces, decoding or additional
application trimming. Node HTTP parsing may remove surrounding optional whitespace.
Syntax does not establish entropy; clients should use at least128bits of CSPRNG entropy.

DTO semantics are unchanged: trimmed valid email max254validator characters, exact
password12..128validator characters, no coercion or unknown fields. Unicode scalar
length remains the existing validator semantics, not JavaScript UTF-16 length.
Frozen HMAC v1 canonicalization and vectors remain unchanged.

## Transport ownership and budgets

`SignupHttpAdapter` uses the public Nest adapter lifecycle, public Node HTTP/HTTPS
constructors and `setHttpServer`. It configures8192header bytes, complete header
inventory (no count truncation),5s header timeout,10s incoming-request timeout,250ms
Node checking interval and5s keep-alive. Forced connection-close mode is rejected;
owned signup work must settle before normal application teardown.

The route additionally rejects more than64header fields, requires one UTF-8 JSON
content type, rejects compressed bodies, and permits at most16384uncompressed body
bytes. Content-Length and actual chunk bytes are both bounded; oversized or stalled
uploads are closed without unbounded drain. A5s upload timer owns incomplete bodies.
The longest tested128-scalar escaped Unicode password fits comfortably below16KiB;
an exactly16KiB valid entity is accepted, the next byte is rejected.

These are measured targets and byte bounds, not whole-request hard deadlines under
event-loop/OS stalls or quarantined native/transport work. Node may return408/431 or
close a syntactically invalid transport before application routing. Such native parser
responses have no claim/admission/domain work and do not promise application JSON/cache
headers. Application responses always use `Cache-Control: no-store`.

## Stable application responses

| Condition                                     | HTTP/body                                                      |
| --------------------------------------------- | -------------------------------------------------------------- |
| New, duplicate account, accepted replay       | 202 `{"status":"accepted"}`                                    |
| Disabled                                      | 403 `HTTP_403 / Signup is disabled`                            |
| Missing/duplicate/malformed key               | 400 `HTTP_400 / Invalid Idempotency-Key`                       |
| Invalid JSON/DTO                              | 400 `HTTP_400 / Invalid signup request`                        |
| Conflicting binding or proven terminal expiry | 409 `HTTP_409 / Idempotency key unavailable`                   |
| Too large body                                | 413 `HTTP_413 / Request too large`                             |
| Unsupported/compressed body                   | 415 `HTTP_415 / Unsupported request body`                      |
| Rate exhausted                                | 429 `HTTP_429 / Too many requests`, dynamic Retry-After        |
| Unknown/transient/unavailable                 | 503 `HTTP_503 / Signup temporarily unavailable`, Retry-After:1 |
| Identified invariant/permission defect        | 500 `INTERNAL_SERVER_ERROR / Internal server error`            |

Error bodies are exactly `{"error":{"code":"...","message":"..."}}`. No account IDs,
existence/replay headers, Location, result timestamps, keys, digests, SQL, DSNs or raw
exceptions are returned/logged. Unexpected failure logging allows only fixed event and
HTTP method. Replays still consume rate/admission; there is no outage bypass.

Clients retry503/network uncertainty with the same key and payload, bounded exponential
backoff and jitter. A missing result or lost acknowledgement does not prove rollback.
409 never authorizes automatic rebinding or a new key.202 is generic acceptance, not a
promise that an account was newly created or verified.

## Proof, cancellation and permission faults

The interceptor returns the response axis while admission retains the full S4 flow,
native hashing and all owner settlements. Actual request abort/response disconnect
cancels new work; it cannot erase positive accepted proof. Nest before-shutdown hooks
drain admission before PostgreSQL/Redis application teardown. No detached domain retry.

A security review identified that missing credential/audit INSERT grants could otherwise
give202 to a duplicate account and500 to a new account. New eligible T2 execution now
checks required SELECT/INSERT privileges for all four domain/result tables before
account-dependent handling. Missing grants fail identically without domain writes.
Committed accepted replay still has precedence. No grants are added or relaxed.

Concurrent privileged DDL/grant changes after a check are an operational assumption
breach; maintenance requires disabled/quiescent writers and containment. This read check
does not lock PostgreSQL ACLs or guarantee equivalence under every infrastructure fault.

## Required validation and remaining gates

The required real HTTP suite contains the9 retained baseline cases plus44 Phase B
cases: raw duplicate/case/OWS/header limits, Unicode and exact body bounds, slow
headers/uploads, malformed/deep DTOs, quotas, disabled behavior, identical/conflicting
retries, T1/T2 lost ACK, missing-result503, cleanup/cancellation, privilege-based
enumeration regression, startup drift and four independent full HTTP API processes.
Disposable test compositions use the real controller, guards, admission, protocol,
restricted PostgreSQL login and Redis Lua; they do not activate the default application.

The timing study alternates8new/8existing requests, verifies actual Argon2 on each and
checks a coarse median ratio0.5..2. Only that test's own ephemeral quota keys are cleared
for calibration. It is a regression target, not statistical proof of production timing
resistance. A representative independent production/ingress timing study remains gated.

Exact-head clean-install CI is required; synthetic/aggregate gated results do not replace
the dedicated real steps. S6 owns final release/security assessment. Production also
requires independent review, authoritative primary/failover lineage and durability,
approved HMAC/anchor and retention/client policy, all-writer protocol adoption, ingress
duplicate preservation/rejection and fleet Argon2 capacity controls. PostgreSQL slots
are not a fleet hashing-memory cap and Redis leases are not PostgreSQL fencing tokens.

Rollback disables/drains/contains signup and retains every claim/result/terminal/audit.
Never restore the historical unkeyed writer or delete ledger history.

References: [Node24 HTTP server options](https://nodejs.org/docs/latest-v24.x/api/http.html#httpcreateserveroptions-requestlistener),
[Nest request lifecycle](https://docs.nestjs.com/faq/request-lifecycle),
[S4 orchestration](S4_SIGNUP_ORCHESTRATION.md), [S2 reservation/expiry ADR](S2_BINDING_AND_EXPIRY_ADR.md).
