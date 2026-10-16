# Isolated local regression

Run from the repository root with Docker Desktop running:

```sh
docker compose -p authcore-full-product-test -f infrastructure/compose.test.yml up -d --wait postgres redis mailpit
docker compose -p authcore-full-product-test -f infrastructure/compose.test.yml run --build --rm runner
docker compose -p authcore-full-product-test -f infrastructure/compose.test.yml stop
```

The distinct project does not reuse historical AuthCore containers or volumes.
PostgreSQL binds host loopback 55433, test Redis binds 56380 and the isolated
test mailbox binds 18025. Mailpit has no external SMTP relay configuration. The Linux runner
shares the disposable PostgreSQL network namespace, so original fixed-port test
safety checks remain intact. All test-created databases are disposable; existing
development databases are never selected. Do not add `-v` teardown commands.

Hosted-only Phase B tests retain their existing guards. A local run reports those
skips honestly; actual GitHub-hosted CI executes and reconciles them. Never set
`GITHUB_ACTIONS` or `RUNNER_ENVIRONMENT` locally to impersonate CI.

This regression environment is separate from the forthcoming interactive demo.
