-- Health acknowledgment for body/treatment services (massage, head spa, facial,
-- waxing). The customer must tick a confirmation that they've disclosed any
-- pregnancy / injuries / health conditions before the booking confirms — a
-- duty-of-care + evidence step. Privacy-light: we store only the acknowledgment
-- timestamp (booking.health_ack_at), NOT structured health data.
--
-- salons.health_ack_required: per-salon override. NULL → use the vertical's
-- default (massage/head_spa/facial/waxing default ON, others OFF). true/false →
-- explicit salon choice.
alter table public.salons
  add column if not exists health_ack_required boolean;

alter table public.bookings
  add column if not exists health_ack_at timestamptz;

comment on column public.salons.health_ack_required is 'Override the per-vertical health-acknowledgment default (NULL = vertical default).';
comment on column public.bookings.health_ack_at is 'When the customer ticked the health acknowledgment at booking (duty-of-care evidence).';
