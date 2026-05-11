-- 2026-05-10 — Heart icon for ALL booking sources, not just walk-ins.
--
-- Adds an explicit boolean so any source (online booking, walk-in,
-- receptionist phone-add) can flag "the customer specifically asked
-- for this staff." The existing `staff_request_note` text column
-- continues to carry the human description when one exists; this new
-- column makes the binary signal first-class so:
--   - online bookings can set it without inventing fake notes,
--   - the receptionist queue/walk-in form can have a checkbox,
--   - the read path stops having to derive has_staff_request from
--     `coalesce(btrim(staff_request_note),'') <> ''` heuristics.
--
-- Backfill: every existing row whose staff_request_note has visible
-- content is treated as requested. This preserves the heart icons
-- already showing on walk-in chips after PR #98 — no regression on
-- live data.

alter table public.bookings
  add column if not exists staff_requested_by_client boolean
    not null default false;

update public.bookings
   set staff_requested_by_client = true
 where coalesce(btrim(staff_request_note), '') <> ''
   and staff_requested_by_client is distinct from true;

comment on column public.bookings.staff_requested_by_client is
  'TRUE when the customer specifically requested this staff member. '
  'Set on insert by online booking (specific staff chosen, not "any"), '
  'walk-in queue (note non-empty OR explicit checkbox), and '
  'receptionist phone-add (checkbox). Drives the ❤️ icon on booking '
  'chips and the "Khách yêu cầu thợ này" line in the drawer.';
