-- Add an immutable, tenant-scoped link from a replacement booking/walk-in to
-- the archived cancelled/no-show booking that caused it. The feature remains
-- default-off; this schema is additive so disabling the release flag is an
-- immediate operational rollback without deleting history.

alter table public.bookings
  add column if not exists recovered_from_booking_id uuid,
  add column if not exists recovery_kind text,
  add column if not exists recovered_by_user_id uuid;

alter table public.bookings
  add constraint bookings_recovered_from_booking_id_fkey
    foreign key (recovered_from_booking_id)
    references public.bookings(id)
    on delete restrict
    not valid,
  add constraint bookings_recovered_by_user_id_fkey
    foreign key (recovered_by_user_id)
    references auth.users(id)
    on delete restrict
    not valid,
  add constraint bookings_recovery_metadata_check
    check (
      (
        recovered_from_booking_id is null
        and recovery_kind is null
        and recovered_by_user_id is null
      )
      or
      (
        recovered_from_booking_id is not null
        and recovery_kind in ('cancelled_rebook', 'no_show_walkin')
        and recovered_by_user_id is not null
      )
    )
    not valid;

alter table public.bookings
  validate constraint bookings_recovered_from_booking_id_fkey,
  validate constraint bookings_recovered_by_user_id_fkey,
  validate constraint bookings_recovery_metadata_check;

comment on column public.bookings.recovered_from_booking_id is
  'Immutable archived booking that caused this replacement booking or walk-in. The archived row is never reopened.';
comment on column public.bookings.recovery_kind is
  'cancelled_rebook creates a new appointment; no_show_walkin creates a new waiting walk-in. No payment action is implied.';
comment on column public.bookings.recovered_by_user_id is
  'Owner/admin who explicitly created the recovery. Retained as durable audit evidence.';

-- One archived terminal booking may create at most one direct replacement.
-- This is also the race-proof guard for repeated clicks.
create unique index if not exists bookings_one_recovery_per_source_uidx
  on public.bookings (recovered_from_booking_id)
  where recovered_from_booking_id is not null;

-- The legacy booking idempotency index includes nullable staff/time fields,
-- so it cannot deduplicate an unassigned walk-in. Recovery gets a tenant-wide
-- key that works even when staff_id/start_time_utc are null.
create unique index if not exists bookings_recovery_idempotency_uidx
  on public.bookings (salon_id, idempotency_key)
  where recovered_from_booking_id is not null
    and idempotency_key is not null;

-- Required for the auth.users ON DELETE RESTRICT foreign-key lookup.
create index if not exists bookings_recovered_by_user_idx
  on public.bookings (recovered_by_user_id)
  where recovered_by_user_id is not null;

-- `salons.feature_flags` has a broad legacy UPDATE policy. Keep this one
-- operational safety key service-controlled so a normal salon member cannot
-- enable the pilot, disable immutable history, or override a Superadmin
-- rollout decision through a direct PostgREST PATCH.
create or replace function public.protect_archived_booking_recovery_flag()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_old_value jsonb;
  v_new_value jsonb;
begin
  if tg_op = 'INSERT' then
    v_old_value := null;
  else
    v_old_value := old.feature_flags -> 'archived_booking_recovery_enabled';
  end if;
  v_new_value := new.feature_flags -> 'archived_booking_recovery_enabled';

  if v_old_value is not distinct from v_new_value then
    return new;
  end if;

  -- An absent/false key on a newly-created salon is the safe default and does
  -- not require privileged handling. Every later change is service-controlled.
  if tg_op = 'INSERT' and coalesce(v_new_value, 'false'::jsonb) <> 'true'::jsonb then
    return new;
  end if;

  -- `current_user` is the function owner inside SECURITY DEFINER and must not
  -- be used as caller identity. `session_user` remains the original database
  -- login role (PostgREST uses authenticator; direct migrations use postgres).
  if v_request_role = 'service_role'
     or session_user in ('postgres', 'supabase_admin') then
    return new;
  end if;

  raise exception 'archived booking recovery flag is service-controlled'
    using errcode = '42501';
end;
$$;

comment on function public.protect_archived_booking_recovery_flag() is
  'Prevents salon-member writes from changing the archived recovery rollout key; Superadmin server actions use service_role.';

revoke all on function public.protect_archived_booking_recovery_flag()
  from public, anon, authenticated;

drop trigger if exists protect_archived_booking_recovery_flag_trigger
  on public.salons;
create trigger protect_archived_booking_recovery_flag_trigger
  before insert or update of feature_flags
  on public.salons
  for each row
  execute function public.protect_archived_booking_recovery_flag();

create or replace function public.validate_archived_booking_recovery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.bookings%rowtype;
  v_authenticated_user_id uuid := (select auth.uid());
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_flag_enabled boolean := false;
  v_has_recovery boolean := false;
begin
  -- While the pilot is enabled, archived terminal rows are append-only source
  -- records. A rollback restores legacy behavior only for untouched rows;
  -- sources that already have a linked replacement stay immutable forever.
  if tg_op = 'UPDATE'
     and old.status in ('cancelled', 'no_show')
     and (
       new.status is distinct from old.status
       or new.salon_id is distinct from old.salon_id
       or new.source is distinct from old.source
       or new.service_id is distinct from old.service_id
       or new.staff_id is distinct from old.staff_id
       or new.client_name is distinct from old.client_name
       or new.client_phone is distinct from old.client_phone
       or new.client_email is distinct from old.client_email
       or new.client_notes is distinct from old.client_notes
       or new.start_time_utc is distinct from old.start_time_utc
       or new.end_time_utc is distinct from old.end_time_utc
       or new.price_cents is distinct from old.price_cents
     ) then
    select exists (
             select 1
               from public.bookings child
              where child.recovered_from_booking_id = old.id
           )
      into v_has_recovery;

    select coalesce(
             (s.feature_flags -> 'archived_booking_recovery_enabled') = 'true'::jsonb,
             false
           )
      into v_flag_enabled
      from public.salons s
     where s.id = old.salon_id;

    if v_has_recovery or (
      v_flag_enabled and not exists (
        select 1
          from public.platform_flags pf
         where pf.key = 'feature_archived_booking_recovery'
           and pf.enabled = false
      )
    ) then
      raise exception 'terminal booking identity and schedule are immutable'
        using errcode = '23514';
    end if;
  end if;

  -- Recovery metadata is append-only. Never turn an existing booking into a
  -- recovery from a browser write or rewrite its source/actor after creation.
  -- The service-only create_recovered_booking RPC is allowed to stamp the new
  -- row returned by create_public_booking inside the same transaction.
  if tg_op = 'UPDATE' and (
    old.recovered_from_booking_id is distinct from new.recovered_from_booking_id
    or old.recovery_kind is distinct from new.recovery_kind
    or old.recovered_by_user_id is distinct from new.recovered_by_user_id
    or (
      old.recovered_from_booking_id is not null
      and (
        old.salon_id is distinct from new.salon_id
        or old.source is distinct from new.source
      )
    )
    or (
      old.recovered_from_booking_id is not null
      and old.idempotency_key is distinct from new.idempotency_key
    )
  ) and not (
    old.recovered_from_booking_id is null
    and old.recovery_kind is null
    and old.recovered_by_user_id is null
    and v_request_role = 'service_role'
  ) then
    raise exception 'booking recovery metadata is immutable'
      using errcode = '23514';
  end if;

  -- Ordinary booking writes take the zero-change fast path.
  if new.recovered_from_booking_id is null then
    return new;
  end if;

  -- Once the link has been validated at creation time, the replacement keeps
  -- following the normal booking lifecycle (waiting -> confirmed/in_progress/
  -- completed, or later cancelled/no_show). Do not re-apply the creation-shape
  -- rule on those ordinary status updates; the immutable metadata check above
  -- still prevents changing the source, kind, actor, or idempotency key.
  if tg_op = 'UPDATE'
     and old.recovered_from_booking_id is not null then
    return new;
  end if;

  if new.id = new.recovered_from_booking_id then
    raise exception 'a booking cannot recover itself'
      using errcode = '23514';
  end if;

  if new.idempotency_key is null then
    raise exception 'booking recovery requires an idempotency key'
      using errcode = '23514';
  end if;

  select b.*
    into v_source
    from public.bookings b
   where b.id = new.recovered_from_booking_id
   for share;

  if not found then
    raise exception 'recovery source booking does not exist'
      using errcode = '23503';
  end if;

  if v_source.salon_id <> new.salon_id then
    raise exception 'recovery source and replacement must belong to the same salon'
      using errcode = '23514';
  end if;

  select coalesce(
           (s.feature_flags -> 'archived_booking_recovery_enabled') = 'true'::jsonb,
           false
         )
    into v_flag_enabled
    from public.salons s
   where s.id = new.salon_id;

  if not v_flag_enabled then
    raise exception 'archived booking recovery is disabled for this salon'
      using errcode = '42501';
  end if;

  -- The platform row is a hard kill-switch: absent/true means available,
  -- while an explicit false overrides every per-salon opt-in.
  if exists (
    select 1
      from public.platform_flags pf
     where pf.key = 'feature_archived_booking_recovery'
       and pf.enabled = false
  ) then
    raise exception 'archived booking recovery is disabled platform-wide'
      using errcode = '42501';
  end if;

  -- Recovery currently suppresses Wix write-back to keep QA outbound-free.
  -- Until an explicit, transactional calendar-sync design exists, fail closed
  -- for Wix-connected salons instead of creating a second unsynchronised
  -- calendar that could double-book the salon.
  if exists (
    select 1
      from public.wix_integrations wi
     where wi.salon_id = new.salon_id
       and wi.enabled = true
  ) then
    raise exception 'archived booking recovery is not available for Wix-connected salons'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
      from public.salon_members sm
     where sm.salon_id = new.salon_id
       and sm.user_id = new.recovered_by_user_id
       and sm.role in ('owner', 'admin')
  ) then
    raise exception 'booking recovery requires an owner or admin actor'
      using errcode = '42501';
  end if;

  -- Browser-authenticated writes cannot attribute the action to another user.
  -- Server-side service-role actions still have to supply a real owner/admin.
  if v_request_role <> 'service_role'
     and session_user not in ('postgres', 'supabase_admin')
     and (
       v_authenticated_user_id is null
       or v_authenticated_user_id <> new.recovered_by_user_id
     ) then
    raise exception 'booking recovery actor does not match authenticated user'
      using errcode = '42501';
  end if;

  if new.recovery_kind = 'cancelled_rebook' then
    if v_source.status <> 'cancelled'
       or new.source <> 'appointment'
       or new.status not in ('pending', 'confirmed') then
      raise exception 'cancelled_rebook requires a cancelled source and a new pending/confirmed appointment'
        using errcode = '23514';
    end if;
  elsif new.recovery_kind = 'no_show_walkin' then
    if v_source.status <> 'no_show'
       or new.source <> 'walkin'
       or new.status <> 'waiting' then
      raise exception 'no_show_walkin requires a no-show source and a new waiting walk-in'
        using errcode = '23514';
    end if;
  else
    raise exception 'unsupported booking recovery kind'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.validate_archived_booking_recovery() is
  'Trigger-only invariant guard for default-off, owner/admin archived booking recovery. It never charges, refunds, reopens, or mutates the source booking.';

drop trigger if exists validate_archived_booking_recovery_trigger
  on public.bookings;
create trigger validate_archived_booking_recovery_trigger
  before insert or update of
    status,
    salon_id,
    source,
    service_id,
    staff_id,
    client_name,
    client_phone,
    client_email,
    client_notes,
    start_time_utc,
    end_time_utc,
    price_cents,
    recovered_from_booking_id,
    recovery_kind,
    recovered_by_user_id,
    idempotency_key
  on public.bookings
  for each row
  execute function public.validate_archived_booking_recovery();

-- Trigger functions are not RPCs. Keep direct invocation closed to every
-- browser role; PostgreSQL can still execute it through the table trigger.
revoke all on function public.validate_archived_booking_recovery()
  from public, anon, authenticated;

-- Private, atomic wrapper used by the authenticated server action. It reuses
-- the proven public-booking validation/conflict engine, then stamps the durable
-- recovery link before the transaction can commit.
create or replace function public.create_recovered_booking(
  p_source_booking_id uuid,
  p_recovery_kind text,
  p_recovered_by_user_id uuid,
  p_idempotency_key uuid,
  p_salon_id uuid,
  p_service_id uuid,
  p_staff_id uuid,
  p_client_name text,
  p_client_phone text,
  p_start_time_utc timestamptz,
  p_end_time_utc timestamptz,
  p_status text,
  p_price_cents integer,
  p_client_notes text,
  p_client_email text,
  p_resource_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_source_status text;
  v_source_salon_id uuid;
  v_existing_booking_id uuid;
  v_existing_idempotency_key uuid;
  v_existing_recovery_kind text;
  v_existing_recovered_by_user_id uuid;
  v_result jsonb;
  v_booking_id uuid;
begin
  if p_source_booking_id is null
     or p_recovery_kind <> 'cancelled_rebook'
     or p_idempotency_key is null then
    return jsonb_build_object(
      'success', false,
      'code', 'invalid_recovery_source'
    );
  end if;

  -- Serialize every attempt for one archived source, including a repeated
  -- request with a different idempotency key.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'archived-booking-recovery:' || p_source_booking_id::text,
      0
    )
  );

  select b.status, b.salon_id
    into v_source_status, v_source_salon_id
    from public.bookings b
   where b.id = p_source_booking_id
   for share;

  if not found
     or v_source_salon_id <> p_salon_id
     or v_source_status <> 'cancelled' then
    return jsonb_build_object(
      'success', false,
      'code', 'invalid_recovery_source'
    );
  end if;

  select
    b.id,
    b.idempotency_key,
    b.recovery_kind,
    b.recovered_by_user_id
    into
      v_existing_booking_id,
      v_existing_idempotency_key,
      v_existing_recovery_kind,
      v_existing_recovered_by_user_id
    from public.bookings b
   where b.recovered_from_booking_id = p_source_booking_id
   limit 1;

  if found then
    if v_existing_idempotency_key = p_idempotency_key
       and v_existing_recovery_kind = p_recovery_kind
       and v_existing_recovered_by_user_id = p_recovered_by_user_id then
      return jsonb_build_object(
        'success', true,
        'booking_id', v_existing_booking_id,
        'replayed', true
      );
    end if;
    return jsonb_build_object(
      'success', false,
      'code', 'already_recovered',
      'booking_id', v_existing_booking_id
    );
  end if;

  v_result := public.create_public_booking(
    p_salon_id,
    p_service_id,
    p_staff_id,
    p_client_name,
    p_client_phone,
    p_start_time_utc,
    p_end_time_utc,
    p_status,
    p_price_cents,
    p_client_notes,
    null::uuid,
    null::integer,
    p_client_email,
    p_resource_id
  );

  if coalesce(v_result ->> 'success', 'false') <> 'true' then
    return v_result;
  end if;

  v_booking_id := nullif(v_result ->> 'booking_id', '')::uuid;
  if v_booking_id is null then
    raise exception 'recovered booking create returned no booking id';
  end if;

  update public.bookings b
     set recovered_from_booking_id = p_source_booking_id,
         recovery_kind = p_recovery_kind,
         recovered_by_user_id = p_recovered_by_user_id,
         idempotency_key = p_idempotency_key
   where b.id = v_booking_id
     and b.salon_id = p_salon_id
     and b.recovered_from_booking_id is null;

  if not found then
    -- Raising (instead of returning a partial success) rolls back the booking
    -- that create_public_booking inserted earlier in this transaction.
    raise exception 'recovered booking stamp failed';
  end if;

  return v_result;
end;
$$;

comment on function public.create_recovered_booking(
  uuid, text, uuid, uuid, uuid, uuid, uuid, text, text, timestamptz,
  timestamptz, text, integer, text, text, uuid
) is
  'Service-only atomic cancelled-booking replacement. Reuses create_public_booking and never reopens or mutates the archived source.';

revoke all on function public.create_recovered_booking(
  uuid, text, uuid, uuid, uuid, uuid, uuid, text, text, timestamptz,
  timestamptz, text, integer, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.create_recovered_booking(
  uuid, text, uuid, uuid, uuid, uuid, uuid, text, text, timestamptz,
  timestamptz, text, integer, text, text, uuid
) to service_role;
