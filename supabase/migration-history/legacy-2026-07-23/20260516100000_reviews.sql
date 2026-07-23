-- Public reviews requested automatically after a booking completes.
-- Used by the Pro+ "Tự động xin đánh giá" / "auto review request"
-- feature surfaced on the landing page.
--
-- Flow:
--   1. updateBookingStatus → completed
--   2. Server checks plan + email presence + idempotency, then INSERTs
--      a row here with a random `request_token` and emails the
--      customer a link `/reviews/<token>`.
--   3. Public form looks up the row by `request_token` (RLS allows
--      anon SELECT by token), customer submits `rating` + `message`,
--      `submitted_at` flips to now().
--   4. Owner panel reads rows where `submitted_at IS NOT NULL`.
--
-- One review per booking (UNIQUE booking_id). Token is opaque random
-- string — defense-in-depth in case a salon owner accidentally shares
-- the link.

create table if not exists public.reviews (
  id              uuid primary key default gen_random_uuid(),
  salon_id        uuid not null references public.salons(id) on delete cascade,
  booking_id      uuid not null references public.bookings(id) on delete cascade unique,
  staff_id        uuid references public.staff(id) on delete set null,
  service_id      uuid references public.services(id) on delete set null,
  /** Denormalised client identity at request time. */
  client_phone    text,
  client_email    text,
  /** Opaque random token used as the public review-form key.
      No salon owner should be able to guess another tenant's token. */
  request_token   text not null unique,
  request_sent_at timestamptz,
  rating          int check (rating between 1 and 5),
  message         text,
  submitted_at    timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists reviews_salon_submitted_idx
  on public.reviews (salon_id, submitted_at desc nulls last);

create index if not exists reviews_token_idx
  on public.reviews (request_token);

alter table public.reviews enable row level security;

-- Anon can read a single row by token (public form needs to render
-- the booking summary before the customer submits).
drop policy if exists "reviews_select_by_token" on public.reviews;
create policy "reviews_select_by_token" on public.reviews
  for select to anon, authenticated
  using (true);

-- All writes via service role only (the request action + submit
-- action both run server-side and use the service-role client).
-- No insert/update/delete policies — keeps writes funnelled through
-- the validated action paths.

comment on table public.reviews is
  'Auto review requests + customer submissions. Pro+ tier feature; '
  'rows are created by updateBookingStatus when a booking flips to '
  '`completed` (idempotent on booking_id). request_token is the '
  'public form key — never expose elsewhere.';
