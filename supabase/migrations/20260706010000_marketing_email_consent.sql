-- Channel-scoped marketing consent.
--
-- `marketing_consent_at` (existing) = FULL opt-in from the online booking
-- checkbox: the customer agreed to SMS *and* email. That gates SMS.
--
-- `marketing_email_consent_at` (new) = EMAIL-ONLY consent, synced from Square's
-- own email-subscription status (Customer.preferences.email_unsubscribed=false).
-- A Square email subscriber has consented to EMAIL marketing, NOT to SMS —
-- TCPA/CASL/GDPR require separate express consent for texts. So this column
-- must ONLY ever unlock the EMAIL channel; SMS stays gated on marketing_consent_at.
alter table public.client_profiles
  add column if not exists marketing_email_consent_at timestamptz;

comment on column public.client_profiles.marketing_email_consent_at is
  'EMAIL-only marketing consent (e.g. synced from Square email-subscription). Never gates SMS — SMS requires marketing_consent_at.';
