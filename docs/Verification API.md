# Email verification API development contract

`POST /api/v1/auth/verify-email`

- Authentication: public credential-proof operation; it creates no session.
- Authorization: possession of an unexpired, unconsumed verification credential
  for an active pending account, enforced by the verifier repository transaction.
- Input: strict UTF-8 uncompressed JSON, maximum 1024 bytes, exactly one `token`
  string in canonical 32-byte base64url format. Query credentials are rejected.
- Success: HTTP200, exactly `{"status":"verified"}`. Responses use no-store and
  a server-generated X-Request-ID correlated to the transactional audit record.
- Errors: HTTP400 for invalid/unavailable credentials (expired, consumed, unknown,
  disabled); 403 for a supplied foreign Origin; 405 for unsupported methods; 413
  for oversized bodies; 415 for unsupported encodings/content types; 429 for rate
  limits; sanitized 503 for unavailable Redis/database/configuration.
- Rate category: verification, Redis-atomic IP/token/global minute buckets
  (20/5/100). Redis failure fails closed. No email-existence lookup is exposed.
- Audit: successful verification appends `identity.email_verified` in the same
  checked transaction as single-use consumption and account transition. Invalid
  token floods do not create unbounded durable audit rows.

`VERIFICATION_DATABASE_URL` must explicitly select the separately provisioned
`authcore_email_verifier_*` principal. There is no fallback to the signup database
principal, automatic migration or automatic grants. Missing configuration leaves
the route unavailable. The regular signup disabled-by-default contract is intact.

The HTTP parser owns a five-second upload target and rejects malformed UTF-8,
extra fields and oversized headers before domain work. The server's inherited
header/request budgets also remain in force; these are scheduling targets, not
hard end-to-end deadline guarantees. Origin validation is additional browser
protection. Verification depends on token proof, not a browser cookie; session
CSRF policy is a separate login/session slice.

Evidence boundaries: focused real HTTP tests control Redis/domain outcomes; real
PostgreSQL token/worker tests independently cover expiry, replay, concurrency,
restricted roles and atomic audit. Combined real Redis/PostgreSQL/HTTP/browser
verification remains an explicit local-demo acceptance task. Bounded resend and
frontend states are follow-on work. This document does not establish demo or
production readiness.
