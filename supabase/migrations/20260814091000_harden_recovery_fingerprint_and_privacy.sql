-- A recovery idempotency key identifies one click; the fingerprint identifies
-- the complete normalized durable intent behind that click.  Exact retries can
-- therefore return the committed canonical child before consulting mutable
-- plan/service/flag state, while changed payloads fail closed.

alter table public.bookings
  add column if not exists recovery_request_fingerprint text;

update public.bookings
   set recovery_request_fingerprint = repeat('0', 64)
 where recovered_from_booking_id is not null
   and recovery_request_fingerprint is null;

alter table public.bookings
  drop constraint if exists bookings_recovery_metadata_check;
alter table public.bookings
  add constraint bookings_recovery_metadata_check
  check (
    (
      recovered_from_booking_id is null
      and recovery_kind is null
      and recovered_by_user_id is null
      and recovery_request_fingerprint is null
    ) or (
      recovered_from_booking_id is not null
      and recovery_kind in ('cancelled_rebook', 'no_show_walkin')
      and recovered_by_user_id is not null
      and recovery_request_fingerprint ~ '^[0-9a-f]{64}$'
    )
  ) not valid;
alter table public.bookings
  validate constraint bookings_recovery_metadata_check;

comment on column public.bookings.recovery_request_fingerprint is
  'SHA-256 of the normalized durable recovery intent. Immutable with the source, kind, actor and idempotency key; contains no raw customer data.';

-- Replace the prior guard so the new fingerprint joins the immutable metadata
-- tuple and the privacy exception clears every field it claims to clear.
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
  -- This trigger is SECURITY DEFINER.  Reserve the direct-owner bypass for
  -- sessions outside a PostgREST/JWT request; a postgres-owned CI connection
  -- which SET ROLE to an application role supplies the matching request role.
  v_privileged_owner_session boolean := (
    session_user in ('postgres', 'supabase_admin')
    and v_request_role = ''
  );
begin
  if tg_op = 'UPDATE'
     and old.status in ('cancelled', 'no_show')
     and current_setting('nailiq.privacy_redaction_booking_id', true) = old.id::text then
    select sa.role into v_redaction_actor_role
      from public.superadmins sa
     where sa.user_id::text = current_setting(
       'nailiq.privacy_redaction_actor_id', true
     )
       and sa.revoked_at is null
       and sa.role in ('founder', 'ops_admin');
    if not (
         v_request_role = 'service_role'
         or v_privileged_owner_session
       ) or not found
       or coalesce(current_setting(
         'nailiq.privacy_redaction_request_id', true
       ), '') = '' then
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
       and new.noshow_charge_error is null
       and new.walkin_request_tags = '[]'::jsonb
       and new.rescheduled_by is null
       and new.wix_booking_id is null
       and new.square_booking_id is null
       and new.stripe_payment_intent_id is null
       and new.square_payment_link_id is null
       and new.square_deposit_order_id is null
       and new.square_payment_id is null
       and new.noshow_payment_id is null
       and new.noshow_fee_order_id is null
       and (
         to_jsonb(new) - array[
           'client_name', 'client_phone', 'client_email', 'client_notes',
           'staff_request_note', 'reference_image_path', 'otp_session_id',
           'client_profile_id', 'client_locale', 'sms_confirmation_error',
           'noshow_card_id', 'noshow_customer_id', 'noshow_card_last4',
           'noshow_card_brand', 'noshow_consent_meta', 'sms_consent_meta',
           'deposit_link_url', 'noshow_fee_link_url', 'noshow_charge_error',
           'walkin_request_tags', 'rescheduled_by', 'wix_booking_id',
           'square_booking_id', 'stripe_payment_intent_id',
           'square_payment_link_id', 'square_deposit_order_id',
           'square_payment_id', 'noshow_payment_id', 'noshow_fee_order_id'
         ]::text[]
       ) = (
         to_jsonb(old) - array[
           'client_name', 'client_phone', 'client_email', 'client_notes',
           'staff_request_note', 'reference_image_path', 'otp_session_id',
           'client_profile_id', 'client_locale', 'sms_confirmation_error',
           'noshow_card_id', 'noshow_customer_id', 'noshow_card_last4',
           'noshow_card_brand', 'noshow_consent_meta', 'sms_consent_meta',
           'deposit_link_url', 'noshow_fee_link_url', 'noshow_charge_error',
           'walkin_request_tags', 'rescheduled_by', 'wix_booking_id',
           'square_booking_id', 'stripe_payment_intent_id',
           'square_payment_link_id', 'square_deposit_order_id',
           'square_payment_id', 'noshow_payment_id', 'noshow_fee_order_id'
         ]::text[]
       ) then
      return new;
    end if;
    raise exception 'privacy redaction may only remove allowlisted customer identifiers'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' and (
    old.recovered_from_booking_id is distinct from new.recovered_from_booking_id
    or old.recovery_kind is distinct from new.recovery_kind
    or old.recovered_by_user_id is distinct from new.recovered_by_user_id
    or old.recovery_request_fingerprint is distinct from new.recovery_request_fingerprint
    or (
      old.recovered_from_booking_id is not null and (
        old.salon_id is distinct from new.salon_id
        or old.source is distinct from new.source
        or old.idempotency_key is distinct from new.idempotency_key
      )
    )
  ) and not (
    old.recovered_from_booking_id is null
    and old.recovery_kind is null
    and old.recovered_by_user_id is null
    and old.recovery_request_fingerprint is null
    and v_request_role = 'service_role'
  ) then
    raise exception 'booking recovery metadata is immutable'
      using errcode = '23514';
  end if;

  if new.recovered_from_booking_id is null then return new; end if;
  if tg_op = 'UPDATE' and old.recovered_from_booking_id is not null then
    return new;
  end if;
  if new.id = new.recovered_from_booking_id
     or new.idempotency_key is null
     or new.recovery_request_fingerprint is null
     or new.recovery_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'booking recovery metadata is invalid'
      using errcode = '23514';
  end if;

  select b.* into v_source from public.bookings b
   where b.id = new.recovered_from_booking_id for share;
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
  ) into v_flag_enabled from public.salons s where s.id = new.salon_id;
  if not v_flag_enabled or exists (
    select 1 from public.platform_flags pf
     where pf.key = 'feature_archived_booking_recovery' and pf.enabled = false
  ) then
    raise exception 'archived booking recovery is disabled'
      using errcode = '42501';
  end if;
  if exists (
    select 1 from public.wix_integrations wi
     where wi.salon_id = new.salon_id and wi.enabled = true
  ) then
    raise exception 'archived booking recovery is not available for Wix-connected salons'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.salon_members sm
     where sm.salon_id = new.salon_id
       and sm.user_id = new.recovered_by_user_id
       and sm.role in ('owner', 'admin')
  ) then
    raise exception 'booking recovery requires an owner or admin actor'
      using errcode = '42501';
  end if;
  if v_request_role <> 'service_role'
     and not v_privileged_owner_session
     and (
       v_authenticated_user_id is null
       or v_authenticated_user_id <> new.recovered_by_user_id
     ) then
    raise exception 'booking recovery actor does not match authenticated user'
      using errcode = '42501';
  end if;

  if new.recovery_kind = 'cancelled_rebook' then
    if v_source.status <> 'cancelled' or new.source <> 'appointment'
       or new.status not in ('pending', 'confirmed') then
      raise exception 'cancelled_rebook has an invalid source or child shape'
        using errcode = '23514';
    end if;
  elsif new.recovery_kind = 'no_show_walkin' then
    if v_source.status <> 'no_show' or new.source <> 'walkin'
       or new.status <> 'waiting' then
      raise exception 'no_show_walkin has an invalid source or child shape'
        using errcode = '23514';
    end if;
  else
    raise exception 'unsupported booking recovery kind'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.validate_archived_booking_recovery()
  from public, anon, authenticated, service_role;
drop trigger if exists validate_archived_booking_recovery_trigger on public.bookings;
create trigger validate_archived_booking_recovery_trigger
  before insert or update on public.bookings
  for each row execute function public.validate_archived_booking_recovery();

-- New full-intent overload.  The replay lookup and fingerprint comparison occur
-- before actor membership, service/add-on validation, feature flags or Wix
-- state.  First creation still applies every one of those mutable prerequisites.
create or replace function public.create_recovered_booking(
  p_source_booking_id uuid,
  p_recovery_kind text,
  p_recovered_by_user_id uuid,
  p_idempotency_key uuid,
  p_request_fingerprint text,
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
  p_resource_id uuid,
  p_addon_service_ids uuid[],
  p_client_locale text,
  p_staff_requested_by_client boolean,
  p_promo_id uuid,
  p_original_price_cents integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_source public.bookings%rowtype;
  v_existing public.bookings%rowtype;
  v_actor_role text;
  v_result jsonb;
  v_booking_id uuid;
  v_audit_id uuid;
  v_addon_count integer := 0;
  v_requested_addon_count integer := 0;
begin
  if p_source_booking_id is null
     or p_recovery_kind is distinct from 'cancelled_rebook'
     or p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('success', false, 'code', 'invalid_recovery_source');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('archived-booking-recovery:' || p_source_booking_id::text, 0)
  );
  select b.* into v_source from public.bookings b
   where b.id = p_source_booking_id and b.salon_id = p_salon_id for share;
  if not found or v_source.status <> 'cancelled' then
    return jsonb_build_object('success', false, 'code', 'invalid_recovery_source');
  end if;
  select b.* into v_existing from public.bookings b
   where b.recovered_from_booking_id = p_source_booking_id limit 1;
  if found then
    if v_existing.idempotency_key = p_idempotency_key
       and v_existing.recovery_kind = p_recovery_kind
       and v_existing.recovered_by_user_id = p_recovered_by_user_id
       and v_existing.recovery_request_fingerprint = p_request_fingerprint then
      return jsonb_build_object(
        'success', true, 'booking_id', v_existing.id, 'replayed', true
      );
    end if;
    return jsonb_build_object(
      'success', false,
      'code', case
        when v_existing.idempotency_key = p_idempotency_key
          then 'idempotency_mismatch'
        else 'already_recovered'
      end,
      'booking_id', v_existing.id
    );
  end if;

  select sm.role into v_actor_role from public.salon_members sm
   where sm.salon_id = p_salon_id
     and sm.user_id = p_recovered_by_user_id
     and sm.role in ('owner', 'admin');
  if not found then
    raise exception 'booking recovery requires an owner or admin actor'
      using errcode = '42501';
  end if;

  select count(distinct requested.id)::integer into v_requested_addon_count
    from unnest(coalesce(p_addon_service_ids, '{}'::uuid[])) requested(id);
  if exists (
    select 1
      from unnest(coalesce(p_addon_service_ids, '{}'::uuid[])) requested(id)
      left join public.services s on s.id = requested.id
       and s.salon_id = p_salon_id and s.deleted_at is null and s.is_addon = true
     where s.id is null
  ) then
    return jsonb_build_object('success', false, 'code', 'invalid_addon');
  end if;

  v_result := public.create_public_booking(
    p_salon_id, p_service_id, p_staff_id, p_client_name, p_client_phone,
    p_start_time_utc, p_end_time_utc, p_status, p_price_cents, p_client_notes,
    null::uuid, null::integer, p_client_email, p_resource_id
  );
  if coalesce(v_result ->> 'success', 'false') <> 'true' then return v_result; end if;
  v_booking_id := nullif(v_result ->> 'booking_id', '')::uuid;
  if v_booking_id is null then raise exception 'recovered booking create returned no id'; end if;

  update public.bookings set
    recovered_from_booking_id = p_source_booking_id,
    recovery_kind = p_recovery_kind,
    recovered_by_user_id = p_recovered_by_user_id,
    recovery_request_fingerprint = p_request_fingerprint,
    idempotency_key = p_idempotency_key,
    booking_channel = 'desk',
    walkin_source = 'phone',
    client_locale = p_client_locale,
    staff_requested_by_client = coalesce(p_staff_requested_by_client, false),
    promo_id = p_promo_id,
    original_price_cents = p_original_price_cents
  where id = v_booking_id and salon_id = p_salon_id
    and recovered_from_booking_id is null;
  if not found then raise exception 'recovered booking stamp failed'; end if;

  if v_requested_addon_count > 0 then
    v_addon_count := public.add_booking_addons(v_booking_id, p_addon_service_ids);
    if v_addon_count <> v_requested_addon_count then
      raise exception 'recovered booking add-on persistence failed';
    end if;
  end if;

  insert into public.booking_events (
    booking_id, salon_id, actor_user_id, actor_role, event_type, payload
  ) values (
    v_booking_id, p_salon_id, p_recovered_by_user_id, v_actor_role,
    'booking_recovered',
    jsonb_build_object(
      'sourceBookingId', p_source_booking_id,
      'recoveryKind', p_recovery_kind,
      'requestFingerprint', p_request_fingerprint
    )
  ) returning id into v_audit_id;
  if v_audit_id is null then raise exception 'recovered booking audit insert failed'; end if;
  insert into public.booking_events (
    booking_id, salon_id, actor_user_id, actor_role, event_type, payload
  ) values (
    v_booking_id, p_salon_id, p_recovered_by_user_id, v_actor_role,
    'booking_created',
    jsonb_build_object(
      'source', 'desk_phone',
      'recoveredFromBookingId', p_source_booking_id,
      'recoveryKind', p_recovery_kind,
      'addonServiceIds', coalesce(p_addon_service_ids, '{}'::uuid[])
    )
  );
  return v_result || jsonb_build_object('replayed', false);
end;
$$;

revoke all on function public.create_recovered_booking(
  uuid, text, uuid, uuid, text, uuid, uuid, uuid, text, text, timestamptz,
  timestamptz, text, integer, text, text, uuid, uuid[], text, boolean, uuid, integer
) from public, anon, authenticated;
grant execute on function public.create_recovered_booking(
  uuid, text, uuid, uuid, text, uuid, uuid, uuid, text, text, timestamptz,
  timestamptz, text, integer, text, text, uuid, uuid[], text, boolean, uuid, integer
) to service_role;
revoke all on function public.create_recovered_booking(
  uuid, text, uuid, uuid, uuid, uuid, uuid, text, text, timestamptz,
  timestamptz, text, integer, text, text, uuid
) from public, anon, authenticated, service_role;

create or replace function public.create_recovered_walkin(
  p_source_booking_id uuid,
  p_recovered_by_user_id uuid,
  p_idempotency_key uuid,
  p_request_fingerprint text,
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
  v_source public.bookings%rowtype;
  v_existing public.bookings%rowtype;
  v_actor_role text;
  v_price_cents integer;
  v_booking_id uuid;
  v_audit_id uuid;
begin
  if p_source_booking_id is null or p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('success', false, 'code', 'invalid_recovery_source');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('archived-booking-recovery:' || p_source_booking_id::text, 0)
  );
  select b.* into v_source from public.bookings b
   where b.id = p_source_booking_id and b.salon_id = p_salon_id for share;
  if not found or v_source.status <> 'no_show' then
    return jsonb_build_object('success', false, 'code', 'invalid_recovery_source');
  end if;
  select b.* into v_existing from public.bookings b
   where b.recovered_from_booking_id = p_source_booking_id limit 1;
  if found then
    if v_existing.idempotency_key = p_idempotency_key
       and v_existing.recovery_kind = 'no_show_walkin'
       and v_existing.recovered_by_user_id = p_recovered_by_user_id
       and v_existing.recovery_request_fingerprint = p_request_fingerprint then
      return jsonb_build_object(
        'success', true, 'booking_id', v_existing.id, 'replayed', true
      );
    end if;
    return jsonb_build_object(
      'success', false,
      'code', case
        when v_existing.idempotency_key = p_idempotency_key
          then 'idempotency_mismatch'
        else 'already_recovered'
      end,
      'booking_id', v_existing.id
    );
  end if;

  if p_salon_id is null or p_service_id is null
     or length(trim(coalesce(p_client_name, ''))) not between 1 and 100
     or p_client_name ~ '[<>{}=&;]'
     or length(regexp_replace(coalesce(p_client_phone, ''), '\D', '', 'g')) < 7
     or length(coalesce(p_staff_request_note, '')) > 200
     or (p_walkin_source is not null and p_walkin_source not in (
       'online', 'walk_in', 'instagram', 'google', 'phone', 'tiktok', 'repeat', 'vip'
     ))
     or (p_walkin_priority is not null and p_walkin_priority not in ('high', 'medium', 'low'))
     or p_walkin_request_tags is null or jsonb_typeof(p_walkin_request_tags) <> 'array'
     or (p_party_size is not null and (p_party_size < 1 or p_party_size > 50)) then
    return jsonb_build_object('success', false, 'code', 'invalid_recovery_source');
  end if;
  select sm.role into v_actor_role from public.salon_members sm
   where sm.salon_id = p_salon_id and sm.user_id = p_recovered_by_user_id
     and sm.role in ('owner', 'admin');
  if not found then
    raise exception 'booking recovery requires an owner or admin actor'
      using errcode = '42501';
  end if;
  select s.price_cents into v_price_cents from public.services s
   where s.id = p_service_id and s.salon_id = p_salon_id and s.deleted_at is null;
  if not found then
    return jsonb_build_object('success', false, 'code', 'invalid_recovery_source');
  end if;

  insert into public.bookings (
    salon_id, service_id, client_name, client_phone, client_notes, staff_id,
    start_time_utc, end_time_utc, status, source, booking_channel,
    joined_queue_at, staff_request_note, staff_requested_by_client, price_cents,
    walkin_source, walkin_priority, walkin_request_tags, party_size,
    recovered_from_booking_id, recovery_kind, recovered_by_user_id,
    recovery_request_fingerprint, idempotency_key
  ) values (
    p_salon_id, p_service_id, trim(p_client_name), p_client_phone, null, null,
    null, null, 'waiting', 'walkin', 'walkin', clock_timestamp(),
    nullif(trim(coalesce(p_staff_request_note, '')), ''),
    coalesce(p_staff_requested_by_client, false), v_price_cents,
    p_walkin_source, p_walkin_priority, p_walkin_request_tags, p_party_size,
    p_source_booking_id, 'no_show_walkin', p_recovered_by_user_id,
    p_request_fingerprint, p_idempotency_key
  ) returning id into v_booking_id;

  insert into public.booking_events (
    booking_id, salon_id, actor_user_id, actor_role, event_type, payload
  ) values (
    v_booking_id, p_salon_id, p_recovered_by_user_id, v_actor_role,
    'booking_recovered', jsonb_build_object(
      'sourceBookingId', p_source_booking_id,
      'recoveryKind', 'no_show_walkin',
      'requestFingerprint', p_request_fingerprint
    )
  ) returning id into v_audit_id;
  if v_audit_id is null then raise exception 'recovered walk-in audit insert failed'; end if;
  insert into public.booking_events (
    booking_id, salon_id, actor_user_id, actor_role, event_type, payload
  ) values
    (v_booking_id, p_salon_id, p_recovered_by_user_id, v_actor_role,
     'walkin_added', jsonb_build_object(
       'serviceId', p_service_id,
       'walkinSource', p_walkin_source,
       'walkinPriority', p_walkin_priority,
       'partySize', p_party_size,
       'recoveredFromBookingId', p_source_booking_id,
       'recoveryKind', 'no_show_walkin'
     )),
    (v_booking_id, p_salon_id, p_recovered_by_user_id, v_actor_role,
     'queue_joined', jsonb_build_object('serviceId', p_service_id));
  return jsonb_build_object(
    'success', true, 'booking_id', v_booking_id, 'replayed', false
  );
end;
$$;

revoke all on function public.create_recovered_walkin(
  uuid, uuid, uuid, text, uuid, uuid, text, text, text, boolean, text, text,
  jsonb, integer
) from public, anon, authenticated;
grant execute on function public.create_recovered_walkin(
  uuid, uuid, uuid, text, uuid, uuid, text, text, text, boolean, text, text,
  jsonb, integer
) to service_role;
revoke all on function public.create_recovered_walkin(
  uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, jsonb, integer
) from public, anon, authenticated, service_role;

-- Booking-scoped privacy redaction. Replay is tenant-bound, the "before"
-- predicate covers every cleared field, and the audit declares that linked
-- booking/account/storage scope remains separately coordinated.
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
  v_existing_actor_user_id uuid;
  v_existing_related_requires_workflow boolean;
  v_existing_scope text;
  v_audit_id uuid;
  v_related_booking_count integer;
begin
  if p_booking_id is null or p_salon_id is null or p_actor_user_id is null
     or p_request_id is null or p_reason_code is null or p_reason_code not in (
       'verified_erasure_request', 'verified_retention_expiry',
       'verified_legal_correction'
     ) then
    return jsonb_build_object('success', false, 'code', 'invalid_request');
  end if;
  select sa.role into v_actor_role from public.superadmins sa
   where sa.user_id = p_actor_user_id and sa.revoked_at is null
     and sa.role in ('founder', 'ops_admin');
  if not found then
    raise exception 'privacy redaction requires founder or ops_admin actor'
      using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('terminal-booking-privacy-redaction:' || p_booking_id::text, 0)
  );
  select
    sal.id,
    sal.reason,
    sal.actor_user_id,
    coalesce(
      (sal.after_jsonb ->> 'relatedRecordsRequireSeparateWorkflow')::boolean,
      false
    ),
    sal.after_jsonb ->> 'scope'
    into
      v_existing_audit_id,
      v_existing_reason_code,
      v_existing_actor_user_id,
      v_existing_related_requires_workflow,
      v_existing_scope
    from public.superadmin_audit_logs sal
   where sal.action = 'terminal_booking_privacy_redacted'
     and sal.target_kind = 'booking'
     and sal.target_id = p_booking_id
     and sal.before_jsonb ->> 'salonId' = p_salon_id::text
     and sal.after_jsonb ->> 'requestId' = p_request_id::text
   limit 1;
  if found then
    if v_existing_reason_code is distinct from p_reason_code
       or v_existing_actor_user_id is distinct from p_actor_user_id
       or v_existing_scope is distinct from 'single_terminal_booking' then
      return jsonb_build_object('success', false, 'code', 'idempotency_mismatch');
    end if;
    return jsonb_build_object(
      'success', true, 'booking_id', p_booking_id, 'replayed', true,
      'audit_id', v_existing_audit_id, 'scope', 'single_terminal_booking',
      'related_records_require_separate_workflow',
      v_existing_related_requires_workflow
    );
  end if;

  select b.status, (
    b.client_name <> '[removed]' or b.client_phone is not null
    or b.client_email is not null or b.client_notes is not null
    or b.staff_request_note is not null or b.reference_image_path is not null
    or b.otp_session_id is not null or b.client_profile_id is not null
    or b.client_locale is not null or b.sms_confirmation_error is not null
    or b.noshow_card_id is not null or b.noshow_customer_id is not null
    or b.noshow_card_last4 is not null or b.noshow_card_brand is not null
    or b.noshow_consent_meta is not null or b.sms_consent_meta is not null
    or b.deposit_link_url is not null or b.noshow_fee_link_url is not null
    or b.noshow_charge_error is not null
    or coalesce(b.walkin_request_tags, '[]'::jsonb) <> '[]'::jsonb
    or b.rescheduled_by is not null or b.wix_booking_id is not null
    or b.square_booking_id is not null or b.stripe_payment_intent_id is not null
    or b.square_payment_link_id is not null
    or b.square_deposit_order_id is not null or b.square_payment_id is not null
    or b.noshow_payment_id is not null or b.noshow_fee_order_id is not null
  ) into v_status, v_personal_data_present
  from public.bookings b
  where b.id = p_booking_id and b.salon_id = p_salon_id
    and b.status in ('cancelled', 'no_show') for update;
  if not found then
    return jsonb_build_object('success', false, 'code', 'invalid_terminal_booking');
  end if;
  select count(*)::integer into v_related_booking_count from public.bookings b
   where b.salon_id = p_salon_id
     and (b.recovered_from_booking_id = p_booking_id or b.id = (
       select source.recovered_from_booking_id from public.bookings source
        where source.id = p_booking_id
     ));

  perform set_config('nailiq.privacy_redaction_booking_id', p_booking_id::text, true);
  perform set_config('nailiq.privacy_redaction_actor_id', p_actor_user_id::text, true);
  perform set_config('nailiq.privacy_redaction_request_id', p_request_id::text, true);
  begin
    update public.bookings set
      client_name = '[removed]', client_phone = null, client_email = null,
      client_notes = null, staff_request_note = null,
      reference_image_path = null, otp_session_id = null,
      client_profile_id = null, client_locale = null,
      sms_confirmation_error = null, noshow_card_id = null,
      noshow_customer_id = null, noshow_card_last4 = null,
      noshow_card_brand = null, noshow_consent_meta = null,
      sms_consent_meta = null, deposit_link_url = null,
      noshow_fee_link_url = null, noshow_charge_error = null,
      walkin_request_tags = '[]'::jsonb, rescheduled_by = null,
      wix_booking_id = null, square_booking_id = null,
      stripe_payment_intent_id = null, square_payment_link_id = null,
      square_deposit_order_id = null, square_payment_id = null,
      noshow_payment_id = null, noshow_fee_order_id = null
    where id = p_booking_id and salon_id = p_salon_id
      and status in ('cancelled', 'no_show');
    if not found then raise exception 'terminal booking privacy redaction update failed'; end if;

    insert into public.superadmin_audit_logs (
      actor_user_id, actor_role, action, target_kind, target_id,
      before_jsonb, after_jsonb, reason
    ) values (
      p_actor_user_id, v_actor_role, 'terminal_booking_privacy_redacted',
      'booking', p_booking_id,
      jsonb_build_object(
        'salonId', p_salon_id, 'status', v_status,
        'personalDataPresent', v_personal_data_present,
        'relatedBookingCount', v_related_booking_count
      ),
      jsonb_build_object(
        'requestId', p_request_id, 'salonId', p_salon_id,
        'redacted', true, 'terminalHistoryRetained', true,
        'scope', 'single_terminal_booking',
        'relatedRecordsRequireSeparateWorkflow', v_related_booking_count > 0
      ),
      p_reason_code
    ) returning id into v_audit_id;
    if v_audit_id is null then raise exception 'terminal booking privacy audit insert failed'; end if;
  exception when others then
    perform set_config('nailiq.privacy_redaction_booking_id', '', true);
    perform set_config('nailiq.privacy_redaction_actor_id', '', true);
    perform set_config('nailiq.privacy_redaction_request_id', '', true);
    raise;
  end;
  perform set_config('nailiq.privacy_redaction_booking_id', '', true);
  perform set_config('nailiq.privacy_redaction_actor_id', '', true);
  perform set_config('nailiq.privacy_redaction_request_id', '', true);
  return jsonb_build_object(
    'success', true, 'booking_id', p_booking_id, 'replayed', false,
    'audit_id', v_audit_id, 'scope', 'single_terminal_booking',
    'related_records_require_separate_workflow', v_related_booking_count > 0
  );
end;
$$;

revoke all on function public.redact_terminal_booking_for_privacy(
  uuid, uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.redact_terminal_booking_for_privacy(
  uuid, uuid, uuid, uuid, text
) to service_role;
