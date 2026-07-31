-- Migration helper: set salons to use Resend outbound email
-- Scope: salon records where email_outbound_enabled is explicitly false.
-- Default excludes archived salons.

BEGIN;

-- 1) Count before
SELECT
  COUNT(*) FILTER (WHERE email_outbound_enabled = false AND archived_at IS NULL) AS active_salons_need_resend,
  COUNT(*) FILTER (WHERE email_outbound_enabled = false) AS all_salons_need_resend
FROM salons;

-- 2) Optional sample of remaining rows before update
SELECT id, slug, name
FROM salons
WHERE email_outbound_enabled = false
  AND archived_at IS NULL
ORDER BY created_at ASC
LIMIT 100;

-- 3) Apply migration
UPDATE salons
SET email_outbound_enabled = true
WHERE email_outbound_enabled = false
  AND archived_at IS NULL;

-- 4) Verify after
SELECT COUNT(*) FILTER (WHERE email_outbound_enabled = false AND archived_at IS NULL) AS active_salons_still_false
FROM salons;

COMMIT;
