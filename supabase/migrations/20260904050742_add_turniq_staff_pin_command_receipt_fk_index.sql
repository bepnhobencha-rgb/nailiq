-- Cover the composite command-receipt foreign key used by TurnIQ staff PIN
-- receipt retention/cleanup. This is additive and does not enable TurnIQ.
-- Rollback: keep the index; dropping it is unnecessary and could slow parent
-- command-receipt maintenance.

CREATE INDEX turniq_staff_pin_shift_command_receipt_fk_idx
  ON public.turniq_staff_pin_shift_receipts (salon_id, command_id);
