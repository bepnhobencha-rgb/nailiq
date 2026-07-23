-- Booking audit / event log. Append-only history for desk + public mutations.
-- Read access (PERMISSION_MATRIX §3): owner + senior get the full salon log.
-- nail_tech is omitted — the schema has no staff↔auth-user linkage today, so
-- the "own bookings only" rule has no DB-level discriminator to rely on. The
-- viewer is owner-gated in the UI anyway. Wire the nail_tech path once
-- `staff.auth_user_id` exists.
-- Writes go through `auditLog.ts` using the service-role client (bypasses RLS).

create table if not exists public.booking_events (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  salon_id uuid not null references public.salons(id) on delete cascade,
  -- Optional: SECURITY DEFINER RPC paths and demo-cookie writes have no
  -- authenticated user; we still log the event with `actor_user_id = null`
  -- and a stable `actor_role` ('public_guest' / 'demo_cookie' / 'system').
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_role text not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.booking_events
  drop constraint if exists booking_events_event_type_check;

alter table public.booking_events
  add constraint booking_events_event_type_check
  check (
    event_type in (
      'booking_created',
      'booking_edited',
      'booking_cancelled',
      'booking_status_changed',
      'walkin_added',
      'addon_added'
    )
  );

alter table public.booking_events
  drop constraint if exists booking_events_actor_role_check;

-- `actor_role` mirrors the membership role vocabulary plus the non-user
-- actors. Kept open as text for forward compat with future roles
-- (`manager`, `trainee`, `viewer`, `accounting`) per PERMISSION_MATRIX §4.
alter table public.booking_events
  add constraint booking_events_actor_role_check
  check (
    actor_role in (
      'owner',
      'senior',
      'nail_tech',
      'manager',
      'trainee',
      'viewer',
      'accounting',
      'public_guest',
      'demo_cookie',
      'system'
    )
  );

create index if not exists booking_events_salon_created_idx
  on public.booking_events (salon_id, created_at desc);

create index if not exists booking_events_booking_idx
  on public.booking_events (booking_id);

alter table public.booking_events enable row level security;

-- Reads: owner + senior get the full salon log.
drop policy if exists "booking_events_select_owner_senior"
  on public.booking_events;

create policy "booking_events_select_owner_senior"
  on public.booking_events
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.salon_members m
      where m.user_id = auth.uid()
        and m.salon_id = booking_events.salon_id
        and m.role in ('owner', 'senior')
    )
  );

-- No INSERT / UPDATE / DELETE policies for non-service-role users — the
-- log is append-only and writes happen via the service-role client only.
-- Service-role bypasses RLS; the absence of a write policy denies
-- everyone else by default (RLS deny-by-default).

comment on table public.booking_events is
  'Append-only audit log for booking mutations. Reads gated to owner/senior (full salon) per PERMISSION_MATRIX §3 (nail_tech path deferred — no staff↔auth user linkage yet). Writes go through the service-role client (auditLog.ts).';
