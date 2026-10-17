# Private local AuthCore demo

This guide describes the explicit disposable development workflow. It does not
authorize production use, external mail or public registration. Full browser
acceptance is tracked separately from service readiness.

## Start

Install Node.js 24+, pnpm 12.8.1 and Docker Desktop (Linux containers). Select a
local Docker context. Administrator elevation is not required for normal work.

Run from the engineering checkout, not a protected historical worktree:

```powershell
pnpm dev:setup
pnpm dev:start
```

Setup installs the frozen dependencies, builds, provisions its own containers,
applies additive migrations and provisions four restricted runtime principals.
Startup builds and launches separate API, worker and Vite web processes.
The explicit demo disables Vite hot reload, so a server restart does not create
an unnecessary blob worker. The strict CSP remains in force. Reload the browser
manually to view source changes.

Preferred addresses: web http://127.0.0.1:3000,
API http://127.0.0.1:4000, mailbox http://127.0.0.1:8025.
Setup probes ports before binding and chooses safe alternatives. Use the actual
printed addresses, also recorded in ignored .local-demo/public.json.

Keep the startup terminal open. Cold startup has a separate 90-second readiness
budget; request/upload/database/native-work security bounds are unchanged.
A healthy API alone does not mean the frontend or worker is ready.

## Use the application

1. Open the web address and choose Create account.
2. Enter a disposable test email and a password of 12–128 characters.
3. Submit once. A retry with unchanged input retains the in-memory Idempotency-Key.
4. Open local test mailbox. No external email is sent.
5. Open the captured verification link and choose Verify email.
6. Sign in with the verified address/password.
7. Review account information, active sessions and device revocation.
8. Sign out. Subsequent server requests using the revoked credential fail.

Unverified/disabled accounts and wrong or unknown credentials receive the same
generic login failure. Registration acceptance does not disclose account existence.
Passwords, session credentials and verification proof never enter browser storage.
The verification fragment is removed before the client submits proof in JSON.
Refreshing before consuming the proof requires reopening the original message.

Current limits: no resend/recovery/MFA/organization workflows yet. A consumed or
expired verification link fails safely; it does not create a session.
The mail-capture UI is trusted local development infrastructure. Cookies do not
isolate ports; the development session path is /api/v1/auth to avoid attaching it
to the mailbox's ordinary /api/v1 endpoints.

## Stop and restart

```powershell
pnpm dev:stop
pnpm dev:start
pnpm demo:check
```

Ctrl+C in the supervisor terminal performs the same graceful owned shutdown.
API and worker receive private IPC cancellation and drain actual work before their
processes close. The supervisor then stops only its recorded Compose project.
It never terminates an arbitrary saved PID or calls docker compose down -v.

Database, Redis AOF and mailbox volumes persist. The same HMAC secret, independent
known-answer metadata and immutable database namespace anchor are reused.
Re-running setup verifies the anchor and authenticates the same restricted roles;
it never changes an existing role password or reseeds an initialized namespace.

## Configuration files

Ignored .local-demo contains:

| File             | Purpose                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| admin.json       | Disposable database-owner provisioning material; never passed to child processes |
| compose.env      | Private Compose credentials/ports                                                |
| api.json         | Signup/auth/verifier capability URLs and independent API secrets                 |
| attestation.json | Separately provisioned known-answer HMAC metadata                                |
| worker.json      | Worker-only database URL, delivery key and local destinations                    |
| public.json      | Nonsecret actual local addresses                                                 |
| processes.json   | Loopback supervisor capability; no arbitrary PID control                         |
| logs/            | Per-run local diagnostics, never publish wholesale                               |

The API local-demo entry requires both NODE_ENV=development and
AUTHCORE_LOCAL_DEMO=true plus its explicit files. It binds only 127.0.0.1.
The normal production entry retains default-disabled signup and supplies no
fallback HMAC configuration. API startup never runs migrations, creates roles,
changes grants or seeds an anchor.

Provisioning rejects remote Docker contexts and containers outside its recorded
project/capability labels and loopback bindings. Existing projects/ports are
preserved. Database owner access is confined to the verified dedicated
authcore_demo container/database.

Files use private creation mode where supported. Windows ACL inheritance is not
claimed to be a production secret manager. Keep the checkout in your private user
profile; do not upload .local-demo, Docker inspect output or raw private reports.

## Validation

```powershell
pnpm demo:check
pnpm test:e2e
```

demo:check verifies actual web/API/PostgreSQL readiness, Redis PING and mailbox
health. It does not claim a browser flow passed.

test:e2e uses real Microsoft Edge on Windows with an isolated profile. Linux uses
Playwright Chromium; install its official browser/dependencies first:

```sh
pnpm exec playwright install --with-deps chromium
```

The browser suite registers a unique synthetic account through the sole signup
path, inspects captured email, verifies it, checks generic invalid/unverified
denial, logs in, checks profile/cookie/storage boundaries, restarts owned services,
checks persistence, revokes another device, logs out and tests replay rejection.
It also checks mobile form layout and keyboard skip navigation. Traces, videos
and screenshot-on-failure are disabled to avoid recording credentials.

The suite deliberately restarts and gracefully stops the named disposable demo.
Run pnpm dev:start again after it finishes. The private dashboard screenshot
contains only synthetic test account information. Tests never clear rate limits
or weaken controls; repeated rapid runs may need to wait for their normal expiry.

Full regression: pnpm test:local uses authcore-full-product-test and preserves
historical services. pnpm test:all runs that regression followed by the browser
suite; start the demo beforehand. GitHub CI supplies the real hosted-only guarded
test evidence separately.

## Troubleshooting

- Docker unavailable: start Docker Desktop normally; verify Linux containers and
  a local context. Do not run the entire agent/session as Administrator.
- Port occupied: setup picks alternatives on first provisioning. Later startup
  preserves configured addresses and fails without stopping an unknown process.
  Inspect your listeners before deliberately changing local configuration.
- Startup/readiness failure: inspect the newest ignored logs for the affected
  owned process. Configuration and data are preserved. Do not reset the database.
- Already running: startup authenticates the existing supervisor and prints its
  addresses. A stale unreachable supervisor file is archived; no PID is killed.
- Graceful stop unavailable: preserve the state/logs and inspect the owned process.
  The tool does not guess which process is safe to terminate.
- Namespace/key/configuration drift: setup/API fail closed. Restore the matching
  private local files from an authorized backup; do not silently regenerate an
  anchor over existing claims.
- Browser verification link unavailable: reopen the original local message. An
  expired/consumed token remains unusable.
- Rate limit: wait for its configured window. Do not disable Redis or clear
  counters to force a successful demonstration.

No teardown command removes data volumes. Destructive removal of real databases,
backups or historical worktrees is outside this workflow.
