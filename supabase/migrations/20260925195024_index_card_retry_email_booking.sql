-- Additive QA follow-up. Rollback may drop only this index; preserve all receipts.
CREATE INDEX booking_card_retry_email_receipts_booking_idx
ON public.booking_card_retry_email_receipts (booking_id);
