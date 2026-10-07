# Identity foundation repository

`@authcore/db` exports `UserRepository`, `DuplicateUserEmailError`, `CreateUserInput`,
and `UserRepositoryDatabase`. No new dependency or schema migration is required.
The existing `users_email_normalized_unique` index enforces uniqueness.

- `new UserRepository(client.db)` uses the existing database client and pool.
- `create({ email, emailNormalized })` returns the persisted user, including
  database-generated UUID and timestamps. Callers cannot set verification,
  disabled status, IDs, or timestamps through this operation.
- `findByNormalizedEmail(emailNormalized)` performs an exact, parameterized
  lookup and returns `User | null`. It includes disabled users; authentication
  policy belongs in the application layer.
- `create` throws `DuplicateUserEmailError` with code `DUPLICATE_EMAIL` when the
  normalized email already exists, including concurrent creates. Its message
  contains no email or database details. Other database errors propagate and
  must not be exposed directly in HTTP responses or logs.

The API identity layer owns validation and `normalizeEmail` (trim and lowercase).
The repository trusts that boundary and never normalizes either input. Dots and
plus tags remain significant. No signup endpoint or HTTP duplicate-email response
is introduced by this persistence foundation.

For an atomic application operation, use `client.db.transaction(async (tx) => …)`
and construct `new UserRepository(tx)` inside the callback. The caller controls
commit/rollback. The repository uses targeted `ON CONFLICT DO NOTHING RETURNING`
instead of a pre-insert lookup, so a handled duplicate does not abort the
transaction. Pool shutdown remains the database client's responsibility.

## PostgreSQL integration tests

Set `TEST_DATABASE_URL` to a local/test PostgreSQL database, then run:

```powershell
pnpm --filter @authcore/db test:integration
```

The suite creates a randomly named `identity_test_*` schema, applies the checked-in
Drizzle migrations there, and drops only that schema after testing. The database
role needs schema creation permission. Existing application tables are not used.
If `TEST_DATABASE_URL` is absent, the suite is explicitly skipped; it never falls
back to `DATABASE_URL`. CI supplies a PostgreSQL 17 service and this variable, so
the repository suite runs there. A configured but unreachable database fails the
suite rather than skipping it.

Coverage includes persisted defaults, exact lookups, SQL-looking input, duplicate
conflicts and concurrency, unrelated database errors and unique constraints,
privileged-field protection, transaction rollback, and continued use of a
transaction after handling a duplicate. Production database builds exclude tests.

CI builds workspace packages before typechecking and testing because dependent
packages resolve their public entrypoints from `dist`.
