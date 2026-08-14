#!/usr/bin/env bash
set -euo pipefail

: "${DB_URL:?DB_URL is required}"

RACE_SALON_ID="92000000-0000-4000-8000-000000000001"
RACE_TMP_DIR="$(mktemp -d)"

cleanup_stripe_race() {
  psql "$DB_URL" -v ON_ERROR_STOP=1 -qAtX \
    -c "delete from public.salons where id = '${RACE_SALON_ID}'" \
    >/dev/null 2>&1 || true
  find "$RACE_TMP_DIR" -mindepth 1 -maxdepth 1 -type f -delete
  rmdir "$RACE_TMP_DIR"
}
trap cleanup_stripe_race EXIT

psql "$DB_URL" -v ON_ERROR_STOP=1 -qAtX <<SQL
insert into public.salons (id, slug, name, phone)
values ('${RACE_SALON_ID}', 'stripe-race-one', 'Stripe Race One', '+15550000003');
SQL

# Hold the first claim transaction open. The second claimant must wait on the
# salon row, then observe the committed attempt and return pending—not acquire a
# second provider request lease.
psql "$DB_URL" -v ON_ERROR_STOP=1 -qAtX >"$RACE_TMP_DIR/first-claim.txt" <<SQL &
begin;
select outcome
from public.claim_stripe_subscription_checkout(
  '${RACE_SALON_ID}', 'pro', repeat('d', 64),
  '2026-08-14 04:00:00+00'
);
select pg_sleep(2);
commit;
SQL
FIRST_CLAIM_PID=$!

sleep 0.2
SECOND_CLAIM="$({
  psql "$DB_URL" -v ON_ERROR_STOP=1 -qAtX -c "
    select outcome
    from public.claim_stripe_subscription_checkout(
      '${RACE_SALON_ID}', 'pro', repeat('d', 64),
      '2026-08-14 04:00:01+00'
    );
  "
} | tr -d '[:space:]')"
wait "$FIRST_CLAIM_PID"

grep -qx "acquired" "$RACE_TMP_DIR/first-claim.txt"
test "$SECOND_CLAIM" = "pending"

# Compare-and-set rehearsal: two customer bindings race on NULL. The loser must
# update zero rows and reread the winner's exact value; it cannot overwrite it.
psql "$DB_URL" -v ON_ERROR_STOP=1 -qAtX \
  -c "update public.salons set stripe_customer_id = null where id = '${RACE_SALON_ID}'" \
  >/dev/null

psql "$DB_URL" -v ON_ERROR_STOP=1 -qAtX >"$RACE_TMP_DIR/first-cas.txt" <<SQL &
begin;
update public.salons
set stripe_customer_id = 'cus_race_winner'
where id = '${RACE_SALON_ID}' and stripe_customer_id is null
returning stripe_customer_id;
select pg_sleep(2);
commit;
SQL
FIRST_CAS_PID=$!

sleep 0.2
psql "$DB_URL" -v ON_ERROR_STOP=1 -qAtX >"$RACE_TMP_DIR/second-cas.txt" <<SQL
begin;
with attempted as (
  update public.salons
  set stripe_customer_id = 'cus_race_loser'
  where id = '${RACE_SALON_ID}' and stripe_customer_id is null
  returning stripe_customer_id
)
select coalesce((select stripe_customer_id from attempted), 'ZERO_ROWS');
select stripe_customer_id from public.salons where id = '${RACE_SALON_ID}';
commit;
SQL
wait "$FIRST_CAS_PID"

grep -qx "cus_race_winner" "$RACE_TMP_DIR/first-cas.txt"
grep -qx "ZERO_ROWS" "$RACE_TMP_DIR/second-cas.txt"
grep -qx "cus_race_winner" "$RACE_TMP_DIR/second-cas.txt"

echo "Stripe billing race rehearsal passed"
