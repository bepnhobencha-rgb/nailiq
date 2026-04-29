-- Extra closed calendar days for public booking (holidays, one-off closures). JSONB array of "YYYY-MM-DD" strings (local salon calendar semantics match booking UI).

alter table public.salons
  add column if not exists booking_closed_dates jsonb not null default '[]'::jsonb;

comment on column public.salons.booking_closed_dates is 'Salon-specific dates with no booking (YYYY-MM-DD strings, local day).';
