# Security requirement traceability

Recovery persistence follow-on: [Password Recovery](Password%20Recovery.md)
adds purpose-separated proof/encryption helpers, version-bound immutable intent,
transactional pending jobs and restricted requester grants. Crypto and real SQL
regressions cover this internal boundary. SR-019/020 remain incomplete: no token
issuance/consumption, password mutation or reset HTTP/browser flow is enabled yet.

M2 verification-resend follow-on: [Registration and Verification Policy](Registration%20and%20Verification%20Policy.md)
adds account-state policy, immutable correlated resend intent, database cooldown/
rolling cap, dedicated HMAC-bound Redis limits and UI. Current focused PostgreSQL
and HTTP evidence is described there; full new-candidate CI remains required.

Checkpoint: verification follow-on candidate, 2026-10-17, based on Draft #28 at
`34c8682d028294beed5fe133ec26e02cc1846205`. This is an implementation/evidence map,
not independent security approval. Each row retains gaps across the complete
product. Requirements remain defined by [Security Requirements](Security%20Requirements.md).

## Evidence references

Paths below are repository-relative. Read actual assertions, not test counts, to
assess coverage. Genuine hosted-only suites retain their environment gates.

| Key | Implementation                                                                                                | Regression evidence                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P   | `packages/crypto/src/password.ts`; signup/auth password owners                                                | `packages/crypto/src/password.test.ts`; `apps/api/src/authentication/password-work.test.ts`; signup admission/capacity suites                          |
| S   | `packages/db/src/repositories/browser-session.repository.ts`; `apps/api/src/authentication/`                  | `packages/db/src/browser-session.integration.test.ts`; `apps/api/src/authentication/browser-http.test.ts`, `browser-auth.e2e.test.ts`                  |
| V   | verification/outbox repositories in `packages/db/src/repositories/`; `apps/worker/src/verification-worker.ts` | `packages/db/src/verification.integration.test.ts`, `email-delivery.integration.test.ts`; worker tests; API `identity/email-verification.http.test.ts` |
| T   | sole signup protocol, owned transaction/driver, restricted SQL principals                                     | signup transaction/outcome/reservation/protocol/capacity/HTTP and Phase B remediation suites; `packages/db/src/runtime-role.integration.test.ts`       |
| B   | `apps/web/src/`; `apps/web/vite.config.ts`                                                                    | `apps/web/src/api.test.ts`; `apps/web/e2e/authentication.pw.ts`                                                                                        |
| D   | `scripts/local-demo.mjs`; explicit local API entry; Compose                                                   | repeated literal setup/start/stop/check; B restart test; `scripts/local-demo.lifecycle.test.mjs`                                                       |
| C   | `.github/workflows/ci.yml`; candidate/evidence/artifact/driver/writer guards                                  | actual CI; `scripts/summarize-phase-b-ci.test.mjs`, `summarize-browser-ci.test.mjs`                                                                    |

## Requirement map

“Current slice” means only the implemented signup/verification/password/session
surface. Pending features have no implied security coverage. Deployment-dependent
controls require actual environment evidence even when local checks pass.

| Requirement                  | Current implementation and evidence                                                                                            | Remaining scope / gate                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| SR-001 Password storage      | P: central maintained native Argon2id, no reversible password storage                                                          | Review future password mutation paths; fleet memory control is not established                                                   |
| SR-002 Password verification | P/S: central verifier, generic wrong/unknown/unverified/disabled responses; native HTTP tests                                  | MFA and recovery admission policies pending                                                                                      |
| SR-003 Password input limits | P/S/T: bounded UTF-8 bodies and central character policy; maximum Unicode compatibility regression                             | Apply same policy to future password reset/change                                                                                |
| SR-004 Session credentials   | S: random 32-byte opaque credentials, purpose-separated digest                                                                 | Independent review and future assurance transitions                                                                              |
| SR-005 Session storage       | S: only token digest stored, explicit response serialization                                                                   | Deployment log pipeline review                                                                                                   |
| SR-006 Browser transport     | S/B: HttpOnly, explicit SameSite/Path; production Secure/__Host policy; browser storage/cookie assertions                      | Real production TLS/proxy and cookie validation                                                                                  |
| SR-007 Expiration            | S: database absolute/idle expiry, same-account device/current/all/others revocation; race tests                                | Admin revocation UI and sensitive-event policies pending                                                                         |
| SR-008 Rotation              | S: login rotation invalidates prior credential                                                                                 | Reauthentication, privilege/MFA/reset-triggered rotation pending                                                                 |
| SR-009 HTTPS                 | Production cookie policy fails secure; D is explicit loopback HTTP only                                                        | Actual production TLS deployment gate                                                                                            |
| SR-010 Server authorization  | S: server verifies account/session for every private operation                                                                 | Organization permission services pending                                                                                         |
| SR-011 Deny default          | S/T: absent/expired/revoked/unavailable evidence denies access; normal signup remains disabled                                 | Full RBAC deny-by-default tests pending                                                                                          |
| SR-012 Tenant isolation      | No organization API is enabled                                                                                                 | Organization-scoped persistence and API checks pending                                                                           |
| SR-013 Cross-tenant tests    | S tests forged cross-account device IDs                                                                                        | Organization A/B read/update/delete tests pending                                                                                |
| SR-014 Permissions           | No RBAC feature exposed                                                                                                        | Explicit permission map/evaluator/enforcement pending                                                                            |
| SR-015 Privilege escalation  | No role assignment feature exposed                                                                                             | Actor/target membership, grant authority and concurrent transitions pending                                                      |
| SR-016 Reauthentication      | Password login exists; no high-risk account mutation UI exposed                                                                | Recent strong-authentication policy and challenge implementation pending                                                         |
| SR-017 MFA                   | Not implemented                                                                                                                | Enrollment, challenge expiry/attempt/replay and server enforcement pending                                                       |
| SR-018 Recovery codes        | Not implemented                                                                                                                | CSPRNG, hash-only storage, one-time use and tests pending                                                                        |
| SR-019 Reset tokens          | Not implemented                                                                                                                | High entropy, database expiry/single-use/hash-only reset workflow pending                                                        |
| SR-020 Reset session policy  | S has atomic session revocation primitives                                                                                     | Atomic password replacement/reset consumption/revocation integration pending                                                     |
| SR-021 Verification tokens   | V: secure random proof, hash-only verifier persistence, DB expiry and single-use concurrent consumption                        | Retry delivery proof is authenticated-encrypted separately; Bounded resend covered; production delivery/retention review pending |
| SR-022 Enumeration           | T/S/V: generic signup, login and invalid-verification responses; current-slice tests                                           | Recovery generic responses and representative timing review pending                                                              |
| SR-023 Rate limits           | T/S/V: dedicated Redis fail-closed request controls                                                                            | Recovery/MFA/OAuth/invitation categories pending                                                                                 |
| SR-024 Multiple dimensions   | T/S: IP and HMAC-bound account dimensions plus native/admission limits; real Redis tests                                       | Device/challenge/client controls for future flows pending                                                                        |
| SR-025 CSRF                  | S: exact Origin plus custom header, SameSite cookies; forged/missing proof tests                                               | Reassess every future cookie-authenticated mutation                                                                              |
| SR-026 XSS                   | B: React escaping, no raw HTML sinks, strict CSP/no script unsafe-eval; zero browser CSP violations                            | Production hosting CSP and wider adversarial UI tests pending                                                                    |
| SR-027 SQL injection         | T/S/V parameterized runtime queries; provisioning uses PostgreSQL format identifiers/literals                                  | Review future SQL paths and runtime privileges                                                                                   |
| SR-028 Inputs                | T/S/V: strict UTF-8/bounded parsing, allowlisted objects, ID/token/Origin validation                                           | Apply to future endpoints                                                                                                        |
| SR-029 Outputs               | S/V: explicit public response fields; B rejects malformed account/session contracts                                            | Full API-wide serialization audit pending                                                                                        |
| SR-030 Secrets               | D: ignored generated local files, no fallback production secret; C artifact/credential guards                                  | Production external secret-manager injection/rotation gate                                                                       |
| SR-031 Secret scope          | D: allowlisted child environment, separate worker/API configurations, four restricted runtime principals                       | Production process/secret-manager permission validation                                                                          |
| SR-032 Cryptography          | P/S/V/T: maintained Argon2id, Node standard random/HMAC/SHA/AES-GCM; exact driver patches preserved                            | Independent crypto integration review; future libraries require review                                                           |
| SR-033 Encryption keys       | V: authenticated delivery ciphertext, key IDs and key-ring support                                                             | Production key custody, rotation/recovery runbook and exercised rotation pending                                                 |
| SR-034 Signing keys          | No OAuth/OIDC token signing is exposed                                                                                         | Signing-key lifecycle/JWKS and operational custody pending                                                                       |
| SR-035 Audit events          | T/S/V transactional signup, verification, login/logout/revocation and delivery events                                          | MFA/reset/org/policy/admin audit and authorized viewer pending                                                                   |
| SR-036 Audit safety          | T/S/V bounded event schemas exclude raw credentials; append-only grants tested                                                 | Full downstream log/export redaction assessment pending                                                                          |
| SR-037 Attribution           | T/S/V user/target/event/timestamp attribution in current schemas                                                               | Unified request/organization correlation pending                                                                                 |
| SR-038 Failure logging       | S login failure audit; V delivery attempts/retries/dead-letter; rate limits deny safely                                        | Unified structured rate-limit/authorization telemetry pending                                                                    |
| SR-039 Error disclosure      | API global filter and bounded current-slice errors; B safe generic failures                                                    | Wider fault-injection and deployment proxy error review pending                                                                  |
| SR-040 Structured logging    | Worker security events and API exception filtering exist                                                                       | Unified structured access/timing/status logging is incomplete                                                                    |
| SR-041 Correlation           | Existing signup request/audit context provides partial attribution                                                             | End-to-end API/outbox/worker/error correlation pending                                                                           |
| SR-042 Durable jobs          | V/T: verification intent commits in sole T2; independent worker leases/backoff/dead-letter/crash tests                         | Additional job types and production queue/backlog monitoring pending                                                             |
| SR-043 Transactions          | T/S/V atomic security writes/audit; owned COMMIT/ROLLBACK classification and unknown outcome recovery                          | Extend ownership to every future mutation; real failover remains unproven                                                        |
| SR-044 Dependencies          | C exact pinned patches/frozen lock/advisory scan; added React/Playwright reviewed for UI/E2E need; upstream notices retained   | Ongoing advisory/maintenance review; no certification implied                                                                    |
| SR-045 Data exposure         | D publishes dedicated PostgreSQL/Redis only on loopback                                                                        | Production private-network validation gate                                                                                       |
| SR-046 Backup                | D ordinary restarts preserve test volumes                                                                                      | Encrypted backups/PITR/restore/failover evidence pending; local persistence is not backup proof                                  |
| SR-047 Regressions           | T/S/V/B realistic concurrency/crash/replay/encoding cases; Unicode login and startup-shutdown regressions                      | Expand with each future security fix                                                                                             |
| SR-048 CI                    | C mandatory Verify retains guarded suites, unique reconciliation and exact live candidate checks; adds actual browser workflow | New resend candidate needs its own CI result; human review remains separate                                                      |
| SR-049 Production access     | D only named disposable local services/roles, no production credentials used                                                   | Production least-privilege/access governance approval gate                                                                       |
| SR-050 Controls              | T unchanged signup/driver/HMAC invariants; strict CSP retained; no hosted-gate spoofing or rate-limit clearing                 | Independent review of changes; no required CI/ruleset weakening permitted                                                        |

## Evidence interpretation

Local full regression passed with genuine hosted-only skips recorded separately.
M1 browser acceptance passed two distinct tests; M2 resend acceptance passed three, with zero skips. Repeated executions
are not added together. Draft #27's 769-test CI is historical backend evidence,
not evidence for every later local-demo edit. CI summaries bind actual base/head
and tested SHA; raw credentials, private mailbox material and raw browser reports
are excluded from artifacts. Do not label the full V1 or any production gate
complete from this matrix.
