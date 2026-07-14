#!/usr/bin/env bash
#
# Build the E2E schema on an empty database.
#
#   scripts/apply-baseline.sh "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
#
# Used by CI and by anyone verifying the baseline locally, so the two cannot
# drift. supabase/bootstrap/schema.sql is never edited: it stays byte-identical
# to what pg_dump produced, because the moment anyone hand-edits it, it silently
# stops being what came off production. Anything that has to be adjusted is
# adjusted HERE, in the open.
set -euo pipefail

DB_URL="${1:?usage: apply-baseline.sh <database-url>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "→ prelude (roles, auth shims, extensions)"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/bootstrap/prelude.sql"

echo "→ schema baseline"
# ALTER DEFAULT PRIVILEGES is filtered out, and only that.
#
# The dump carries 24 of them, half `FOR ROLE supabase_admin`. On a Supabase
# stack the connection is `postgres`, which is NOT a member of supabase_admin, so
# those statements fail with "permission denied to change default privileges" and
# take the whole apply down with them — the first CI attempt died there, 11,678
# lines in.
#
# Dropping them is safe, and the reason is narrow: default privileges govern
# grants on objects created LATER by those roles. A throwaway test database
# creates no new objects at runtime — the suite inserts rows, it does not create
# tables. The grants on the 81 tables that DO exist come from the 391 GRANT
# statements in the dump, and those are asserted table-by-table in
# scripts/check-schema-parity.ts (anon 75/81, authenticated 75/81,
# service_role 81/81 — the six anon cannot reach ARE the PII protection).
grep -v '^ALTER DEFAULT PRIVILEGES ' "$ROOT/supabase/bootstrap/schema.sql" \
  | psql "$DB_URL" -v ON_ERROR_STOP=1 -q

echo "✓ baseline applied"
