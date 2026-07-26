-- Salon logo shown on the public booking page header.
--
-- Twilio Toll-Free Verification asks that a customer sent from the business's
-- own site to a third-party booking page still recognises who they are booking
-- with. The page showed the salon's NAME but only stock imagery.
alter table public.salons
  add column if not exists logo_url text;

comment on column public.salons.logo_url is
  'Public URL of the salon logo (salon-imports bucket). NULL → booking header shows the name only.';
