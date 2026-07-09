-- Twilio Toll-Free Verification wants the opt-in screen to link the policies of
-- the BUSINESS whose number is registered, not the platform's. Salons that have
-- their own site (Hi-Lite → hiliteheadspa.com/privacy) point at it; the rest
-- fall back to NailIQ's own /privacy and /terms.
alter table public.salons
  add column if not exists privacy_url text,
  add column if not exists terms_url   text;

comment on column public.salons.privacy_url is
  'Absolute URL to the salon''s own privacy policy. NULL → booking page links to NailIQ /privacy.';
comment on column public.salons.terms_url is
  'Absolute URL to the salon''s own terms. NULL → booking page links to NailIQ /terms.';
