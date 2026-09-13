-- A capability-authorized removal can settle locally when the booking has no
-- card. The claim RPC already locks the booking, checks scope/epoch/fingerprint,
-- writes an already_removed result and consumes the capability atomically.
-- That no-op has no provider receipt: do not manufacture one or drop the
-- receipt requirement for actual provider removals.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.booking_card_management_operations
  DROP CONSTRAINT booking_card_operation_completion_check;
ALTER TABLE public.booking_card_management_operations
  ADD CONSTRAINT booking_card_operation_completion_check CHECK (
    (status = 'sending' AND completed_at IS NULL AND result_json IS NULL
      AND provider_reference IS NULL AND error_code IS NULL)
    OR (status = 'succeeded' AND completed_at IS NOT NULL AND result_json IS NOT NULL
      AND (
        provider_reference IS NOT NULL
        OR (
          provider_reference IS NULL AND error_code IS NULL
          AND provider_material = '{}'::jsonb
          AND result_json @> '{"ok":true,"code":"already_removed","idempotent":false}'::jsonb
          AND result_json->>'booking_id' = booking_id::text
          AND result_json->>'salon_id' = salon_id::text
        ) IS TRUE
      ))
    OR (status IN ('failed','unknown') AND completed_at IS NOT NULL
      AND result_json IS NOT NULL AND error_code IS NOT NULL)
  );

COMMIT;
