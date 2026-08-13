-- Durable Waitlist handling evidence.
--
-- These columns are additive and nullable so existing salons and entries keep
-- their exact behaviour. The UI remains gated by `waitlist_attention_enabled`.
alter table public.booking_waitlist_entries
  add column if not exists acknowledged_at timestamptz,
  add column if not exists acknowledged_by_user_id uuid
    references auth.users(id) on delete set null;

comment on column public.booking_waitlist_entries.acknowledged_at is
  'First time an authorized salon staff member opened the Waitlist handling surface.';

comment on column public.booking_waitlist_entries.acknowledged_by_user_id is
  'Salon member who first acknowledged the Waitlist entry; null for legacy/unacknowledged rows.';

-- Link every delivery attempt back to its Waitlist lead. This makes retries,
-- delivery status, and complaint investigation auditable without storing PII
-- in an event payload.
alter table public.booking_notifications
  add column if not exists waitlist_entry_id uuid
    references public.booking_waitlist_entries(id) on delete set null;

create index if not exists booking_notifications_waitlist_entry_idx
  on public.booking_notifications (salon_id, waitlist_entry_id, created_at desc)
  where waitlist_entry_id is not null;

