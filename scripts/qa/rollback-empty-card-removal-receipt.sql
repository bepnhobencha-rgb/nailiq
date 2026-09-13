-- Operator-reviewed rollback only. Never delete receipts to make this pass.
-- Restoring the old constraint also restores the already-empty-card HTTP 503.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.booking_card_management_operations IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.booking_card_management_operations
    WHERE status = 'succeeded' AND provider_reference IS NULL) THEN
    RAISE EXCEPTION 'Rollback blocked: preserve existing local no-op receipts';
  END IF;
END $$;
ALTER TABLE public.booking_card_management_operations
  DROP CONSTRAINT booking_card_operation_completion_check;
ALTER TABLE public.booking_card_management_operations
  ADD CONSTRAINT booking_card_operation_completion_check CHECK (
    (status='sending' AND completed_at IS NULL AND result_json IS NULL
      AND provider_reference IS NULL AND error_code IS NULL)
    OR (status='succeeded' AND completed_at IS NOT NULL AND result_json IS NOT NULL
      AND provider_reference IS NOT NULL)
    OR (status IN ('failed','unknown') AND completed_at IS NOT NULL
      AND result_json IS NOT NULL AND error_code IS NOT NULL)
  );
COMMIT;
