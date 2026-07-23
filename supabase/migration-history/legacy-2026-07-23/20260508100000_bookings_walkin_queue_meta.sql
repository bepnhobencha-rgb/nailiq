-- Walk-in queue metadata: receptionist-tagged origin (channel), priority,
-- free-text request tags, and party size. All nullable so existing
-- appointment / older walk-in rows are unaffected.
--
-- `walkin_source` is distinct from the existing operational `source`
-- column ("appointment" | "walkin"); this column captures the channel /
-- origin (online, instagram, etc.) and is meaningful only for walk-ins.

alter table public.bookings
  add column if not exists walkin_source text,
  add column if not exists walkin_priority text,
  add column if not exists walkin_request_tags jsonb,
  add column if not exists party_size integer;

alter table public.bookings
  drop constraint if exists bookings_walkin_source_check;
alter table public.bookings
  add constraint bookings_walkin_source_check
  check (
    walkin_source is null
    or walkin_source in (
      'online',
      'walk_in',
      'instagram',
      'google',
      'phone',
      'tiktok',
      'repeat',
      'vip'
    )
  );

alter table public.bookings
  drop constraint if exists bookings_walkin_priority_check;
alter table public.bookings
  add constraint bookings_walkin_priority_check
  check (
    walkin_priority is null
    or walkin_priority in ('high', 'medium', 'low')
  );

alter table public.bookings
  drop constraint if exists bookings_party_size_check;
alter table public.bookings
  add constraint bookings_party_size_check
  check (party_size is null or (party_size >= 1 and party_size <= 50));

comment on column public.bookings.walkin_source is
  'Walk-in origin / channel (online | walk_in | instagram | google | phone | tiktok | repeat | vip). Distinct from operational `source`; null for appointments.';
comment on column public.bookings.walkin_priority is
  'Receptionist-set urgency for walk-ins (high | medium | low).';
comment on column public.bookings.walkin_request_tags is
  'Free-text request chips for walk-in queue (e.g. ["Wants Tina"]). Validated app-side.';
comment on column public.bookings.party_size is
  'Number of people in the walk-in party (>= 1, <= 50).';
