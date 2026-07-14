# supabase/bootstrap

`schema.sql` lives here: the **schema-only** dump of production, used to stand up the
E2E test database. It is not committed yet — see `docs/E2E-TEST-DATABASE.md` for the
one command that produces it.

Why a dump and not the migrations: the 262 files in `supabase/migrations/` cannot
rebuild the database. The core tables — `salons`, `bookings`, `staff`, `services` —
have **no `CREATE TABLE` anywhere in the repo**; the migrations only `ALTER` tables
that were created by hand on the live project years of drift ago. `db push` against
an empty project dies on the first file, which is exactly why
`scripts/db-push-guard.js` exists.

## The one rule

**Structure only. Never data.**

`--schema-only` is not a preference, it is the whole safety property. Production holds
11,226 real customers and 4,787 real bookings. Copying any of it into a test database
turns a routine test failure into a privacy incident, and a public repo turns it into a
disclosure. Before committing the dump:

```bash
# must print 0
grep -c "^COPY \|^INSERT INTO " supabase/bootstrap/schema.sql
```

If that number is not zero, stop. Do not commit. Re-run the dump with `--schema-only`.
