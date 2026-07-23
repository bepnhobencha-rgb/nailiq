-- No-show card-on-file: store the card's display fingerprint (brand + last4) so
-- the customer-facing "manage your saved card" page and the confirmation email
-- can show "Visa •••• 3332" WITHOUT a live provider round-trip, and persist a
-- server-authored consent record (the exact policy text + amount shown at save
-- time) as chargeback / dispute evidence.
--
-- Card PANs are NEVER stored — only the brand + last 4 (PCI-allowed display
-- fields). The real card lives in the provider vault, referenced by
-- noshow_card_id (already present from 20260611000000).

alter table public.bookings
  add column if not exists noshow_card_last4 text,
  add column if not exists noshow_card_brand text,
  -- { policyText, feeCents, currency, locale, capturedAt } — what the customer
  -- agreed to, captured server-side at save time (evidence for disputes).
  add column if not exists noshow_consent_meta jsonb;

comment on column public.bookings.noshow_card_last4 is 'Last 4 of the saved no-show card (display only; PCI-allowed).';
comment on column public.bookings.noshow_card_brand is 'Brand of the saved no-show card (e.g. VISA) — display only.';
comment on column public.bookings.noshow_consent_meta is 'Server-authored record of the no-show policy the customer agreed to (text + amount + locale + timestamp) for dispute evidence.';
