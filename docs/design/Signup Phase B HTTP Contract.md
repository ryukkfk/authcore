# Signup Phase B HTTP Contract

> Design proposal for human review, 2026-10-12. Baseline:
> `a0bd2d7ff6499e393a3dabb46617f6292f23c84e` (merged documentation PR #10).
> No Phase B behavior is implemented or approved by this document.
> `SIGNUP_ENABLED=false`; AUTH-001 remains incomplete; production readiness is not established.

## Approval boundary

This is a proposed enabled-development contract for `POST /api/v1/auth/signup`.
Mandatory keys, new error mappings, transport limits, expiry and admission behavior
require owner approval (D01-D06). There is no optional unkeyed fallback in the preferred
design: mixing legacy execution with keyed execution would invalidate its assumptions.
Disabled signup remains the source default; approving this design does not enable it.

## Parsing and validation

Require exactly one case-insensitive `Idempotency-Key` field. Inspect Node `rawHeaders`
before normalized header access so duplicate field lines, including identical duplicates
and differently cased names, are rejected. Reject comma-joined values, quotes, Unicode,
embedded spaces, control characters, extra application trimming and decoding. The value
must contain 16-128 characters, each in `[A-Za-z0-9_-]`. Implement the existing explicit
length checks plus negative-character check; do not rely on a JavaScript `$` anchor
which can match before a final newline. Node/proxy parsing can remove HTTP optional whitespace;
this is not a promise to recover original wire bytes. Test the real HTTP parser and the
approved ingress behavior; an ingress that hides duplicates must reject them itself.

Missing, duplicate or malformed key yields the same safe 400 message. Do not echo keys.
Recommend at least 128 bits of CSPRNG entropy (for example 22 base64url characters),
never an email, password or sequential identifier. Syntax cannot prove randomness.
The endpoint is currently global identity signup, not tenant-scoped; adding tenant scope
later requires a new reviewed contract, not silently inserting a v1 tuple element.

Existing DTO policy remains: trimmed valid email with maximum length 254; password
length 12-128 according to existing validator semantics, exact password characters
preserved; no unknown properties or implicit coercion. The hasher's 1,024 UTF-16-unit
input caps are additional bounds, not a replacement password policy. Do not replace
Unicode DTO length semantics with JavaScript `string.length`.

Frozen v1 bytes from the [hasher](../../packages/crypto/src/signup-idempotency.ts):

```text
UTF-8 JSON.stringify(["authcore.signup.key",1,rawKey])
UTF-8 JSON.stringify(["authcore.signup.payload",1,email.trim(),email.trim().toLowerCase(),password])
```

No BOM/newline, sorting, Unicode normalization, password trimming or case folding of
the key. Both digests are lowercase HMAC-SHA-256 hex. `keyVersion=1`, `payloadVersion=1`
and positive `hmacKeyVersion` are separate metadata; the latter is not added to either
tuple. Changing display-email case can conflict even when normalized email is equal.
Use only the validated DTO fields. Do not persist raw key, payload or password for replay.
An explicitly injected dedicated 32-byte secret is required; no insecure fallback.

## Processing order and denial-of-service bounds

1. Transport parser enforces proposed 16 KiB decoded JSON body bound, rejects compressed
   request bodies for this route, and applies bounded header size/timeouts. Exact ingress
   and Node header/connection limits need D02 approval and integration tests. These are
   proposed controls, not existing guarantees. Parser errors can occur before guards.
2. `SignupEnabledGuard`: routable requests get existing 403 when disabled. Do not claim
   the guard runs before JSON parsing or all transport work.
3. Existing socket-address/global rate limiting: every retry/replay consumes quota.
   Existing limits are 5/IP/10 minutes and 30 global/minute; spoofable proxy headers
   remain ignored. A Redis error fails closed with 503; denied quota gives 429.
4. Proposed key-validation guard after rate limiting, before admission. This preserves
   baseline rate-before-validation behavior and bounds malformed-key attacks.
5. Existing admission interceptor (four local/distributed slots) runs before DTO pipes.
   DTO-invalid requests can briefly consume admission; finally must release after settlement.
6. DTO validation -> HMAC -> T1 reservation -> optional Argon2 -> T2 -> bounded recovery.
   Check admission and cancellation at mutation boundaries. Release after actual work,
   not merely after the response wait times out.

Bound waiting, body/header memory, database acquisition and lock work. No unbounded
server retry loops. Retained replays still require Redis/rate/admission; availability
is intentionally sacrificed during Redis outage. A future replay-only bypass needs a
separate abuse/capacity review. Never refund an ambiguously consumed Redis rate token.

## Stable outcomes (proposed except existing 202/403/429/500 shapes)

All application responses use `Cache-Control: no-store` (new proposed policy). No
`Idempotency-Replayed`, account identifiers, account existence, result timestamps,
`Location`, binding digests, raw key or internal SQL/Redis details are returned.

| Condition | HTTP and exact JSON body | Retry policy |
| --- | --- | --- |
| New account, duplicate email, identical committed replay | 202 `{"status":"accepted"}` | Terminal accepted for this request; does not promise email verification or a newly created account |
| Disabled route | 403 `{"error":{"code":"HTTP_403","message":"Signup is disabled"}}` | Do not retry until authorized configuration changes |
| Missing/duplicate/malformed key | 400 `{"error":{"code":"HTTP_400","message":"Invalid Idempotency-Key"}}` | Correct header; never expose its value |
| Invalid DTO | 400 `{"error":{"code":"HTTP_400","message":"Invalid signup request"}}` | Correct request; proposed generic mapping replaces current safe validator details |
| Same key/different binding, or synchronized refusal under selected D04 | 409 `{"error":{"code":"HTTP_409","message":"Idempotency key unavailable"}}` | No auto key/payload change. A requires durable terminal proof; B is current timestamp policy refusal and can reverse after clock correction; selection pending |
| Pending/unknown outcome, lock/deadlock/transient DB failure, unavailable Redis/DB, no capacity, detected HMAC configuration failure | 503 `{"error":{"code":"HTTP_503","message":"Signup temporarily unavailable"}}` with `Retry-After: 1` | Same key and same payload, bounded exponential backoff plus jitter |
| Rate exhausted | 429 `{"error":{"code":"HTTP_429","message":"Too many requests"}}` with existing dynamic `Retry-After` | Wait; same key/payload |
| Unexpected invariant failure or restricted-role permission denial | 500 `{"error":{"code":"INTERNAL_SERVER_ERROR","message":"Internal server error"}}` | Operator investigation; no privilege relaxation or fabricated result |
| Proposed body limit exceeded | 413 `{"error":{"code":"HTTP_413","message":"Request too large"}}` | Reduce body; parser-level normalization needs adapter tests |
| Proposed unsupported media/compressed body | 415 `{"error":{"code":"HTTP_415","message":"Unsupported request body"}}` | Use uncompressed JSON; adapter tests required |

Malformed JSON uses the proposed fixed400 `Invalid signup request` body; parser errors
and unsupported/compressed body handling require adapter mappings before activation.
Node may close a syntactically invalid header
connection before an application response. These transport outcomes never reserve a
claim. Existing global exception behavior is evidence, not proof of those proposed mappings.

The ledger stores only accepted 202, never 400/403/409/429/500/503 or a synthetic pending
202. A reservation, successful hash or successful audit INSERT alone is not success.
Concurrent identical requests either replay the winner after lock release or receive
503 while waiting exceeds budget. Concurrent conflicting requests resolve through the
unique binding: a durable winner causes 409 for the loser; an uncommitted winner that
rolls back has not established a permanent binding.

After client timeout/disconnect, retry the same key/payload. Network failure does not
prove rollback. A claim with a retained result replays 202 regardless of cutoff; selected-policy refusal
without result never authorizes rebinding. Timestamp-only refusal is not durable terminality. A new key after 409 is a new intent requiring
explicit client/user policy, not automated recovery of the old operation (D04/D07).

## D06 proof precedence and D04 expiry qualification

Pending [D06](Signup%20Phase%20B%20D06%20Decision.md) distinguishes exact COMMIT_ACK
from promise resolution and COMMIT_ROLLBACK. Only validated atomic T2 commit or a
fresh matching authoritative immutable result latches accepted business proof.
T1 reservation is not signup success. Once this request has valid accepted proof,
catch/finally/rollback/end/release/Redis cleanup errors cannot change its generic
202 conclusion. Delivery may fail after disconnect; durable outcome remains accepted.
Cleanup health/alerts are separate. A fresh request still passes guards/rate/admission;
this rule creates no bypass. Without proof, unknown/transient recovery failure is503,
and a no-proof invariant/permission defect follows safe500 mapping.

[D04](Signup%20Phase%20B%20D04%20Decision.md) is unresolved. Permanent 409 after durable
terminalization (A) requires separately approved state/grants; timestamp-only B can
return409 now and permit eligibility after backward clock correction. Neither a
current-clock refusal nor a missing result proves rollback. T3 never writes an expiry
fact: under A a timestamp-only miss without terminal proof stays503; under B a valid
current refusal can be409. Existing accepted results replay before expiry checks.
No schema, grants, public response activation or implemented T3 is claimed here.

## Enumeration and information boundaries

Duplicate-email accepted results follow the same HTTP shape as new signup. Replays do
not inspect account state. Conflict only reveals possession/reuse of an unpredictable
key, not whether an email exists. Low-entropy keys weaken that separation. Equal response
bodies do not establish timing resistance: unique-index waits, hashing, replay paths,
cache effects and operational failures still need dedicated timing analysis. No random
sleep is presented as a proof. Registration policy and email verification remain missing.

Node [HTTP parser reference](https://nodejs.org/docs/latest-v24.x/api/http.html) and
Nest [request lifecycle](https://docs.nestjs.com/faq/request-lifecycle) support the parsing
and lifecycle boundaries. See [Architecture](Signup%20Phase%20B%20Architecture.md),
[Failure Matrix](Signup%20Phase%20B%20Failure%20Matrix.md) and
[Decision Register](Signup%20Phase%20B%20Decision%20Register.md).
