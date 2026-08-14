-- Cancelled and no-show bookings are durable operational history, independent
-- of the archived-recovery rollout flag. Replacing the trigger function in
-- place keeps this forward migration additive: it does not rewrite or delete
-- existing rows. A tightly-scoped service-only privacy redaction RPC below is
-- the sole exception for otherwise-locked name/contact fields and also clears
-- related reusable identifiers in one audited transaction.
--
-- This trigger deliberately does not claim to intercept DELETE. PostgreSQL and
-- service_role retain hard-delete capability for separately-authorized account
-- erasure and retention workflows. Product/server actions never use DELETE to
-- undo a terminal status; BOOK-018's invariant is the operational row state,
-- schedule and source identity, not indefinite retention of personal data.

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
  v_redaction_actor_role text;
begin
  -- A privacy erasure request may remove direct identifiers while retaining a
  -- non-identifying terminal history row. The service-only RPC sets all three
  -- transaction-local values; the trigger independently validates the active
  -- platform actor and the exact, redaction-only row delta.
  if tg_op = 'UPDATE'
     and old.status in ('cancelled', 'no_show')
     and current_setting(
       'nailiq.privacy_redaction_booking_id', true
     ) = old.id::text then
    select sa.role
      into v_redaction_actor_role
      from public.superadmins sa
     where sa.user_id::text = current_setting(
       'nailiq.privacy_redaction_actor_id', true
     )
       and sa.revoked_at is null
       and sa.role in ('founder', 'ops_admin');

    if not (
         v_request_role = 'service_role'
         or session_user in ('postgres', 'supabase_admin')
       )
       or not found
       or current_setting(
         'nailiq.privacy_redaction_request_id', true
       ) is null
       or current_setting(
         'nailiq.privacy_redaction_request_id', true
       ) = '' then
      raise exception 'terminal booking privacy redaction is not authorized'
        using errcode = '42501';
    end if;

    if new.client_name = '[removed]'
       and new.client_phone is null
       and new.client_email is null
       and new.client_notes is null
       and new.staff_request_note is null
       and new.reference_image_path is null
       and new.otp_session_id is null
       and new.client_profile_id is null
       and new.client_locale is null
       and new.sms_confirmation_error is null
       and new.noshow_card_id is null
       and new.noshow_customer_id is null
       and new.noshow_card_last4 is null
       and new.noshow_card_brand is null
       and new.noshow_consent_meta is null
       and new.sms_consent_meta is null
       and new.deposit_link_url is null
       and new.noshow_fee_link_url is null
       and (
         to_jsonb(new) - array[
           'client_name',
           'client_phone',
           'client_email',
           'client_notes',
           'staff_request_note',
           'reference_image_path',
           'otp_session_id',
           'client_profile_id',
           'client_locale',
           'sms_confirmation_error',
           'noshow_card_id',
           'noshow_customer_id',
           'noshow_card_last4',
           'noshow_card_brand',
           'noshow_consent_meta',
           'sms_consent_meta',
           'deposit_link_url',
           'noshow_fee_link_url'
         ]::text[]
       ) = (
         to_jsonb(old) - array[
           'client_name',
           'client_phone',
           'client_email',
           'client_notes',
           'staff_request_note',
           'reference_image_path',
           'otp_session_id',
           'client_profile_id',
           'client_locale',
           'sms_confirmation_error',
           'noshow_card_id',
           'noshow_customer_id',
           'noshow_card_last4',
           'noshow_card_brand',
           'noshow_consent_meta',
           'sms_consent_meta',
           'deposit_link_url',
           'noshow_fee_link_url'
         ]::text[]
       ) then
      return new;
    end if;

    raise exception 'privacy redaction may only remove direct customer identifiers'
      using errcode = '23514';
  end if;

  -- Terminal source identity and schedule are immutable for every operational
  -- UPDATE, including service_role. No-show charge/waive fields remain writable
  -- so the archived detail can record the eventual fee outcome.
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
       or new.deleted_at is distinct from old.deleted_at
     ) then
    raise exception 'terminal booking identity and schedule are immutable'
      using errcode = '23514';
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
  'Trigger-only invariant guard: cancelled/no-show operational identity and schedule reject UPDATE; default-off owner/admin recovery creates a linked child. Service-only audited privacy redaction is the narrow identifier exception; DELETE remains a privileged retention/account-erasure operation outside this trigger.';

-- Recreate the existing trigger so soft-deleting a terminal source is also
-- rejected. The trigger/function names are unchanged, so schema object counts
-- and downstream grants remain stable.
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
    deleted_at,
    recovered_from_booking_id,
    recovery_kind,
    recovered_by_user_id,
    idempotency_key
  on public.bookings
  for each row
  execute function public.validate_archived_booking_recovery();

revoke all on function public.validate_archived_booking_recovery()
  from public, anon, authenticated;

-- Recreate the cancelled-appointment recovery RPC so the linked child and its
-- actor/link audit row either commit together or both roll back. Exact retries
-- also repair a missing legacy best-effort audit before acknowledging success.
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
  v_actor_role text;
  v_audit_id uuid;
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

  select sm.role
    into v_actor_role
    from public.salon_members sm
   where sm.salon_id = p_salon_id
     and sm.user_id = p_recovered_by_user_id
     and sm.role in ('owner', 'admin');
  if not found then
    raise exception 'booking recovery requires an owner or admin actor'
      using errcode = '42501';
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
      select be.id
        into v_audit_id
        from public.booking_events be
       where be.booking_id = v_existing_booking_id
         and be.salon_id = p_salon_id
         and be.actor_user_id = p_recovered_by_user_id
         and be.event_type = 'booking_recovered'
         and be.payload ->> 'sourceBookingId' = p_source_booking_id::text
         and be.payload ->> 'recoveryKind' = p_recovery_kind
       limit 1;
      if not found then
        insert into public.booking_events (
          booking_id,
          salon_id,
          actor_user_id,
          actor_role,
          event_type,
          payload
        ) values (
          v_existing_booking_id,
          p_salon_id,
          p_recovered_by_user_id,
          v_actor_role,
          'booking_recovered',
          jsonb_build_object(
            'sourceBookingId', p_source_booking_id,
            'recoveryKind', p_recovery_kind
          )
        ) returning id into v_audit_id;
      end if;
      if v_audit_id is null then
        raise exception 'recovered booking audit insert failed';
      end if;
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
    raise exception 'recovered booking stamp failed';
  end if;

  insert into public.booking_events (
    booking_id,
    salon_id,
    actor_user_id,
    actor_role,
    event_type,
    payload
  ) values (
    v_booking_id,
    p_salon_id,
    p_recovered_by_user_id,
    v_actor_role,
    'booking_recovered',
    jsonb_build_object(
      'sourceBookingId', p_source_booking_id,
      'recoveryKind', p_recovery_kind
    )
  ) returning id into v_audit_id;

  if v_audit_id is null then
    raise exception 'recovered booking audit insert failed';
  end if;

  return v_result;
end;
$$;

comment on function public.create_recovered_booking(
  uuid, text, uuid, uuid, uuid, uuid, uuid, text, text, timestamptz,
  timestamptz, text, integer, text, text, uuid
) is
  'Service-only atomic cancelled-booking replacement: linked child and booking_recovered actor audit commit together; exact retry repairs a missing legacy audit.';

revoke all on function public.create_recovered_booking(
  uuid, text, uuid, uuid, uuid, uuid, uuid, text, text, timestamptz,
  timestamptz, text, integer, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.create_recovered_booking(
  uuid, text, uuid, uuid, uuid, uuid, uuid, text, text, timestamptz,
  timestamptz, text, integer, text, text, uuid
) to service_role;

-- No-show late arrival follows the same transaction boundary. Ordinary walk-in
-- creation remains unchanged; only a linked recovery uses this service-only RPC.
create or replace function public.create_recovered_walkin(
  p_source_booking_id uuid,
  p_recovered_by_user_id uuid,
  p_idempotency_key uuid,
  p_salon_id uuid,
  p_service_id uuid,
  p_client_name text,
  p_client_phone text,
  p_staff_request_note text,
  p_staff_requested_by_client boolean,
  p_walkin_source text,
  p_walkin_priority text,
  p_walkin_request_tags jsonb,
  p_party_size integer
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
  v_actor_role text;
  v_price_cents integer;
  v_booking_id uuid;
  v_audit_id uuid;
begin
  if p_source_booking_id is null
     or p_idempotency_key is null
     or p_salon_id is null
     or p_service_id is null
     or p_client_name is null
     or length(trim(p_client_name)) < 1
     or length(trim(p_client_name)) > 100
     or p_client_name ~ '[<>{}=&;]'
     or length(regexp_replace(coalesce(p_client_phone, ''), '\D', '', 'g')) < 7
     or length(coalesce(p_staff_request_note, '')) > 200
     or p_walkin_source is not null
        and p_walkin_source not in (
          'online', 'walk_in', 'instagram', 'google', 'phone', 'tiktok',
          'repeat', 'vip'
        )
     or p_walkin_priority is not null
        and p_walkin_priority not in ('high', 'medium', 'low')
     or p_walkin_request_tags is null
     or jsonb_typeof(p_walkin_request_tags) <> 'array'
     or p_party_size is not null
        and (p_party_size < 1 or p_party_size > 50) then
    return jsonb_build_object(
      'success', false,
      'code', 'invalid_recovery_source'
    );
  end if;

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
     or v_source_status <> 'no_show' then
    return jsonb_build_object(
      'success', false,
      'code', 'invalid_recovery_source'
    );
  end if;

  select sm.role
    into v_actor_role
    from public.salon_members sm
   where sm.salon_id = p_salon_id
     and sm.user_id = p_recovered_by_user_id
     and sm.role in ('owner', 'admin');
  if not found then
    raise exception 'booking recovery requires an owner or admin actor'
      using errcode = '42501';
  end if;

  select s.price_cents
    into v_price_cents
    from public.services s
   where s.id = p_service_id
     and s.salon_id = p_salon_id
     and s.deleted_at is null;
  if not found then
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
       and v_existing_recovery_kind = 'no_show_walkin'
       and v_existing_recovered_by_user_id = p_recovered_by_user_id then
      select be.id
        into v_audit_id
        from public.booking_events be
       where be.booking_id = v_existing_booking_id
         and be.salon_id = p_salon_id
         and be.actor_user_id = p_recovered_by_user_id
         and be.event_type = 'booking_recovered'
         and be.payload ->> 'sourceBookingId' = p_source_booking_id::text
         and be.payload ->> 'recoveryKind' = 'no_show_walkin'
       limit 1;
      if not found then
        insert into public.booking_events (
          booking_id,
          salon_id,
          actor_user_id,
          actor_role,
          event_type,
          payload
        ) values (
          v_existing_booking_id,
          p_salon_id,
          p_recovered_by_user_id,
          v_actor_role,
          'booking_recovered',
          jsonb_build_object(
            'sourceBookingId', p_source_booking_id,
            'recoveryKind', 'no_show_walkin'
          )
        ) returning id into v_audit_id;
      end if;
      if v_audit_id is null then
        raise exception 'recovered walk-in audit insert failed';
      end if;
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

  insert into public.bookings (
    salon_id,
    service_id,
    client_name,
    client_phone,
    client_notes,
    staff_id,
    start_time_utc,
    end_time_utc,
    status,
    source,
    booking_channel,
    joined_queue_at,
    staff_request_note,
    staff_requested_by_client,
    price_cents,
    walkin_source,
    walkin_priority,
    walkin_request_tags,
    party_size,
    recovered_from_booking_id,
    recovery_kind,
    recovered_by_user_id,
    idempotency_key
  ) values (
    p_salon_id,
    p_service_id,
    trim(p_client_name),
    p_client_phone,
    null,
    null,
    null,
    null,
    'waiting',
    'walkin',
    'walkin',
    clock_timestamp(),
    nullif(trim(coalesce(p_staff_request_note, '')), ''),
    coalesce(p_staff_requested_by_client, false),
    v_price_cents,
    p_walkin_source,
    p_walkin_priority,
    p_walkin_request_tags,
    p_party_size,
    p_source_booking_id,
    'no_show_walkin',
    p_recovered_by_user_id,
    p_idempotency_key
  ) returning id into v_booking_id;

  insert into public.booking_events (
    booking_id,
    salon_id,
    actor_user_id,
    actor_role,
    event_type,
    payload
  ) values (
    v_booking_id,
    p_salon_id,
    p_recovered_by_user_id,
    v_actor_role,
    'booking_recovered',
    jsonb_build_object(
      'sourceBookingId', p_source_booking_id,
      'recoveryKind', 'no_show_walkin'
    )
  ) returning id into v_audit_id;

  if v_audit_id is null then
    raise exception 'recovered walk-in audit insert failed';
  end if;

  return jsonb_build_object(
    'success', true,
    'booking_id', v_booking_id,
    'replayed', false
  );
end;
$$;

comment on function public.create_recovered_walkin(
  uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text,
  jsonb, integer
) is
  'Service-only atomic no-show late-arrival recovery: waiting walk-in child and booking_recovered actor audit commit together.';

revoke all on function public.create_recovered_walkin(
  uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text,
  jsonb, integer
) from public, anon, authenticated;
grant execute on function public.create_recovered_walkin(
  uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text,
  jsonb, integer
) to service_role;

-- Privacy requests retain non-identifying operational/financial history while
-- removing direct customer identifiers and reusable capability URLs. Payment
-- transaction IDs remain available for legal/accounting retention. Related
-- photos/storage and salon/account deletion are coordinated by their own
-- erasure workflow; this RPC does not overclaim whole-account completion.
create or replace function public.redact_terminal_booking_for_privacy(
  p_booking_id uuid,
  p_salon_id uuid,
  p_actor_user_id uuid,
  p_request_id uuid,
  p_reason_code text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_actor_role text;
  v_status text;
  v_personal_data_present boolean;
  v_existing_audit_id uuid;
  v_existing_reason_code text;
  v_audit_id uuid;
begin
  if p_booking_id is null
     or p_salon_id is null
     or p_actor_user_id is null
     or p_request_id is null
     or p_reason_code is null
     or p_reason_code not in (
       'verified_erasure_request',
       'verified_retention_expiry',
       'verified_legal_correction'
     ) then
    return jsonb_build_object('success', false, 'code', 'invalid_request');
  end if;

  select sa.role
    into v_actor_role
    from public.superadmins sa
   where sa.user_id = p_actor_user_id
     and sa.revoked_at is null
     and sa.role in ('founder', 'ops_admin');
  if not found then
    raise exception 'privacy redaction requires founder or ops_admin actor'
      using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'terminal-booking-privacy-redaction:' || p_booking_id::text,
      0
    )
  );

  select sal.id, sal.reason
    into v_existing_audit_id, v_existing_reason_code
    from public.superadmin_audit_logs sal
   where sal.action = 'terminal_booking_privacy_redacted'
     and sal.target_kind = 'booking'
     and sal.target_id = p_booking_id
     and sal.actor_user_id = p_actor_user_id
     and sal.after_jsonb ->> 'requestId' = p_request_id::text
   limit 1;
  if found then
    if v_existing_reason_code is distinct from p_reason_code then
      return jsonb_build_object(
        'success', false,
        'code', 'idempotency_mismatch'
      );
    end if;
    return jsonb_build_object(
      'success', true,
      'booking_id', p_booking_id,
      'replayed', true,
      'audit_id', v_existing_audit_id
    );
  end if;

  select
    b.status,
    (
      b.client_name <> '[removed]'
      or b.client_phone is not null
      or b.client_email is not null
      or b.client_notes is not null
      or b.staff_request_note is not null
      or b.reference_image_path is not null
      or b.otp_session_id is not null
      or b.client_profile_id is not null
      or b.noshow_card_id is not null
      or b.noshow_customer_id is not null
      or b.deposit_link_url is not null
      or b.noshow_fee_link_url is not null
    )
    into v_status, v_personal_data_present
    from public.bookings b
   where b.id = p_booking_id
     and b.salon_id = p_salon_id
     and b.status in ('cancelled', 'no_show')
   for update;
  if not found then
    return jsonb_build_object(
      'success', false,
      'code', 'invalid_terminal_booking'
    );
  end if;

  perform set_config(
    'nailiq.privacy_redaction_booking_id', p_booking_id::text, true
  );
  perform set_config(
    'nailiq.privacy_redaction_actor_id', p_actor_user_id::text, true
  );
  perform set_config(
    'nailiq.privacy_redaction_request_id', p_request_id::text, true
  );

  begin
    update public.bookings b
       set client_name = '[removed]',
           client_phone = null,
           client_email = null,
           client_notes = null,
           staff_request_note = null,
           reference_image_path = null,
           otp_session_id = null,
           client_profile_id = null,
           client_locale = null,
           sms_confirmation_error = null,
           noshow_card_id = null,
           noshow_customer_id = null,
           noshow_card_last4 = null,
           noshow_card_brand = null,
           noshow_consent_meta = null,
           sms_consent_meta = null,
           deposit_link_url = null,
           noshow_fee_link_url = null
     where b.id = p_booking_id
       and b.salon_id = p_salon_id
       and b.status in ('cancelled', 'no_show');
    if not found then
      raise exception 'terminal booking privacy redaction update failed';
    end if;

    insert into public.superadmin_audit_logs (
      actor_user_id,
      actor_role,
      action,
      target_kind,
      target_id,
      before_jsonb,
      after_jsonb,
      reason
    ) values (
      p_actor_user_id,
      v_actor_role,
      'terminal_booking_privacy_redacted',
      'booking',
      p_booking_id,
      jsonb_build_object(
        'salonId', p_salon_id,
        'status', v_status,
        'personalDataPresent', v_personal_data_present
      ),
      jsonb_build_object(
        'requestId', p_request_id,
        'redacted', true,
        'terminalHistoryRetained', true
      ),
      p_reason_code
    ) returning id into v_audit_id;

    if v_audit_id is null then
      raise exception 'terminal booking privacy audit insert failed';
    end if;
  exception
    when others then
      perform set_config('nailiq.privacy_redaction_booking_id', '', true);
      perform set_config('nailiq.privacy_redaction_actor_id', '', true);
      perform set_config('nailiq.privacy_redaction_request_id', '', true);
      raise;
  end;

  perform set_config('nailiq.privacy_redaction_booking_id', '', true);
  perform set_config('nailiq.privacy_redaction_actor_id', '', true);
  perform set_config('nailiq.privacy_redaction_request_id', '', true);

  return jsonb_build_object(
    'success', true,
    'booking_id', p_booking_id,
    'replayed', false,
    'audit_id', v_audit_id
  );
end;
$$;

comment on function public.redact_terminal_booking_for_privacy(
  uuid, uuid, uuid, uuid, text
) is
  'Service-only, founder/ops-admin-attributed privacy exception. Direct identifiers are redacted and a non-PII superadmin audit with an allowlisted reason code commits in the same transaction; operational/financial history remains unchanged.';

revoke all on function public.redact_terminal_booking_for_privacy(
  uuid, uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.redact_terminal_booking_for_privacy(
  uuid, uuid, uuid, uuid, text
) to service_role;
