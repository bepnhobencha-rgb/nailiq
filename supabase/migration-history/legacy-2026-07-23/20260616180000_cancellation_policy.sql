-- Per-salon Cancellation / No-Show / Deposit policy. Admin-editable (no
-- hardcode), bilingual. jsonb { en, vi }. NULL/empty → the app falls back to a
-- built-in bilingual default so every salon has a coherent policy on day one.
alter table public.salons
  add column if not exists cancellation_policy jsonb;

comment on column public.salons.cancellation_policy is 'Admin-editable cancellation/no-show/deposit policy, bilingual { en, vi }. Shown at /[slug]/policy and linked from the booking consent + confirmation email.';
