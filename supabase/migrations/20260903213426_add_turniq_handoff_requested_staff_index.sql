-- TurnIQ M4R performance follow-up.
--
-- Covers the nullable requested-technician foreign key used by handoff receipt
-- and reconciliation lookups. This migration changes no rollout flag, salon
-- setting, booking, provider configuration, or notification state.
--
-- Rollback (only before live handoff traffic depends on this index):
--   DROP INDEX public.turniq_handoff_item_requested_staff_fk_idx;

BEGIN;

CREATE INDEX turniq_handoff_item_requested_staff_fk_idx
  ON public.turniq_handoff_plan_items (requested_staff_id)
  WHERE requested_staff_id IS NOT NULL;

DO $proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'turniq_handoff_plan_items'
      AND indexname = 'turniq_handoff_item_requested_staff_fk_idx'
      AND indexdef LIKE '%(requested_staff_id)%'
      AND indexdef LIKE '%WHERE (requested_staff_id IS NOT NULL)%'
  ) THEN
    RAISE EXCEPTION
      'TurnIQ handoff requested_staff_id covering index proof failed';
  END IF;
END
$proof$;

COMMIT;
