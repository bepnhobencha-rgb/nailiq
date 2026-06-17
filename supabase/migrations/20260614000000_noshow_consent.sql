-- No-show card-on-file CONSENT timestamp.
-- A saved card can only be charged after the customer explicitly agreed to the
-- salon's no-show policy + card-on-file authorization (legal / chargeback
-- defense). Stamped when the card is saved with consent; chargeNoShowFee
-- refuses to charge when this is null.
alter table public.bookings
  add column if not exists noshow_consent_at timestamptz;

comment on column public.bookings.noshow_consent_at is
  'When the customer agreed to the no-show policy + card-on-file authorization (consent for charging the saved card). Null = never charge.';
