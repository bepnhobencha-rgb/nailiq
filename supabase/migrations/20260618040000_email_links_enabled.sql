-- Per-salon toggle: also send important booking links (save-card, deposit,
-- waitlist invite) by EMAIL alongside SMS.
--
-- Why default TRUE: US carriers silently filter link-bearing SMS from numbers
-- not registered for A2P 10DLC, so a texted link often never reaches the
-- customer. Emailing the same link in parallel is the resilient fallback, so it
-- ships ON for every salon; an owner can turn it off if they run SMS-only.

alter table public.salons
  add column if not exists email_links_enabled boolean not null default true;

comment on column public.salons.email_links_enabled is
  'When true (default), desk-sent links (save-card / deposit / waitlist invite) '
  'are also emailed to the customer when an email is on file, alongside the SMS. '
  'Resilient fallback for US A2P 10DLC SMS link filtering.';
