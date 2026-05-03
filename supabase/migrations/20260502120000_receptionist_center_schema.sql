-- Receptionist Center V1: salon timezone, walk-in columns + relaxed nulls,
-- bookings source discipline,
-- authenticated INSERT scoped to salon membership (replacing unrestricted with check (true)).
-- Overlap / double-book: Pre-flight v1 uses server-side query checks (+ UI in v2); no DB EXCLUDE here.

-- -----------------------------------------------------------------------------
-- 1. Salon timezone (grid “today”, formatting in app)
-- -----------------------------------------------------------------------------
alter table public.salons
  add column if not exists timezone text not null default 'America/Los_Angeles';

comment on column public.salons.timezone is 'IANA zone id for Receptionist grid + date picker (stored times remain UTC).';

-- -----------------------------------------------------------------------------
-- 2. Walk-in / operational fields on bookings
-- -----------------------------------------------------------------------------
alter table public.bookings
  add column if not exists source text not null default 'appointment',
  add column if not exists joined_queue_at timestamptz,
  add column if not exists started_at timestamptz,
  add column if not exists staff_request_note text;

-- Existing rows get default 'appointment' from add-column default; no backfill UPDATE.

-- -----------------------------------------------------------------------------
-- 3. Relax NOT NULL so queued walk-ins can omit slot + staff + phone
-- -----------------------------------------------------------------------------
alter table public.bookings alter column start_time_utc drop not null;
alter table public.bookings alter column end_time_utc drop not null;
alter table public.bookings alter column staff_id drop not null;
alter table public.bookings alter column client_phone drop not null;

-- -----------------------------------------------------------------------------
-- 4. Source whitelist
-- -----------------------------------------------------------------------------
alter table public.bookings drop constraint if exists bookings_source_check;

alter table public.bookings
  add constraint bookings_source_check
  check (source in ('appointment', 'walkin'));

comment on column public.bookings.source is 'appointment = normal booking row; walkin = Receptionist queue + chair flow.';
comment on column public.bookings.joined_queue_at is 'Walk-in enqueue time (unscheduled / in-queue row; status uses existing booking lifecycle values).';
comment on column public.bookings.started_at is 'When service starts (e.g. chair occupied); optional operational timestamp.';

-- -----------------------------------------------------------------------------
-- 5. Authenticated INSERT: must target a salon where the user is a member.
-- Replaces permissive bookings_insert_authenticated (with check (true)).
-- Note: SECURITY DEFINER RPCs bypass RLS; anon INSERT policy unchanged.
-- -----------------------------------------------------------------------------
drop policy if exists "bookings_insert_authenticated" on public.bookings;

create policy "bookings_insert_authenticated"
  on public.bookings
  for insert
  to authenticated
  with check (
    salon_id in (
      select salon_id from public.salon_members
      where user_id = auth.uid()
    )
  );

-- -----------------------------------------------------------------------------
-- 6. Extend bookings.status whitelist for walk-in lifecycle
-- Pre-flight v1 lock decision #2: status enum extension
-- -----------------------------------------------------------------------------
alter table public.bookings drop constraint if exists bookings_status_check;

alter table public.bookings
  add constraint bookings_status_check
  check (status in (
    'pending',
    'confirmed',
    'completed',
    'cancelled',
    'waiting',
    'in_progress'
  ));

comment on constraint bookings_status_check on public.bookings is
  'Lifecycle: appointment uses pending->confirmed->in_progress->completed; walkin uses waiting->confirmed->in_progress->completed; cancelled terminal.';
