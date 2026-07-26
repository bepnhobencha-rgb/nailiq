-- "Hold until card": mark online bookings that MUST leave a card (new / high-risk
-- + provider connected + protection on). Set right after risk scoring. The
-- release-pending cron auto-cancels these if no card is saved within the grace
-- window, so the slot isn't held by a customer who never committed a card.
alter table public.bookings
  add column if not exists noshow_card_required boolean not null default false;

comment on column public.bookings.noshow_card_required is
  'True when this booking must leave a card-on-file (new/high-risk). Auto-released by the release-pending cron if noshow_card_id stays null past the grace window.';
