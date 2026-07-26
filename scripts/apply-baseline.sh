#!/usr/bin/env bash
#
# Build the E2E schema on an empty database.
#
#   scripts/apply-baseline.sh "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
#
# Used only for an empty local/CI database. Production deploys must use the
# migration-history guard and must never run this script.
#
# The folded migration is generated from the immutable production snapshot and
# all reviewed schema-bearing deltas. Applying that exact artifact here keeps
# E2E, the migration rehearsal, and a fresh install on the same schema path.
set -euo pipefail

DB_URL="${1:?usage: apply-baseline.sh <database-url>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FOLDED_BASELINE="$ROOT/supabase/migrations/20260723000000_folded_production_schema_baseline.sql"

if [[ ! -f "$FOLDED_BASELINE" ]]; then
  echo "missing folded baseline: $FOLDED_BASELINE" >&2
  exit 1
fi

echo "→ folded production-schema baseline"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$FOLDED_BASELINE"

echo "→ forward migrations after the folded baseline"
baseline_name="${FOLDED_BASELINE##*/}"
forward_count=0
for migration in "$ROOT"/supabase/migrations/*.sql; do
  migration_name="${migration##*/}"
  if [[ "$migration_name" > "$baseline_name" ]]; then
    echo "  → $migration_name"
    psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$migration"
    forward_count=$((forward_count + 1))
  fi
done
echo "✓ applied $forward_count forward migration(s)"

echo "→ reference data (lookup tables the schema cannot work without)"
# service_categories and platform_flags are global lookup tables, not anyone's
# data. services.category has a FK into service_categories, so an empty one means
# the seed cannot create a single service — CI failed on exactly that.
# No customers, no bookings, no salons, no auth users. See the file.
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/bootstrap/reference-data.sql"

echo "✓ baseline applied"
