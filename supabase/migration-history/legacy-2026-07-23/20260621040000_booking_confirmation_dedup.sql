-- Race-proof guard against duplicate booking-confirmation notifications.
--
-- Root cause of the "2 confirmation emails" bug: two paths send the rich email
-- (publicBookingSideEffects + /api/booking/sms-confirm), and the only dedup
-- guard (a count==0 check in the route) was both racy AND defeated because the
-- email path never logged a booking_notifications row (it was selecting a
-- non-existent `currency` column, nulling the salon lookup and skipping the log).
--
-- This partial unique index makes the claim atomic: the first sender inserts a
-- `(booking_id, channel)` row for notification_type='booking_confirmation' and
-- wins; concurrent senders hit a 23505 unique violation and skip. Scoped to
-- booking_confirmation only so it never constrains reminders, review requests,
-- or inbound SMS replies (which may legitimately repeat or have a null booking).

create unique index if not exists booking_notifications_confirmation_once
  on public.booking_notifications (booking_id, channel)
  where notification_type = 'booking_confirmation' and booking_id is not null;
