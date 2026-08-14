-- Terminal booking rows are operational tombstones.  Browser roles may not
-- create them, enter them with an arbitrary multi-column PATCH, or mutate them
-- after entry.  Trusted server workflows use narrowly-scoped RPCs which both
-- authorize the actor/state transition and write an audit row in the same
-- transaction.  No RPC in this migration calls a payment provider.

create or replace function public.enforce_terminal_booking_write_boundary()
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
  v_transition_scope text := coalesce(
    current_setting('nailiq.terminal_transition_scope', true),
    ''
  );
  v_fee_booking_id text := coalesce(
    current_setting('nailiq.terminal_fee_mutation_booking_id', true),
    ''
  );
  -- SECURITY DEFINER makes current_user the function owner.  Preserve the
  -- maintenance exemption only for a direct owner session outside a
  -- PostgREST/JWT request.  A postgres-owned CI connection which SET ROLE to an
  -- application role must set the matching request role and is not exempt.
  v_privileged_owner_session boolean := (
    session_user in ('postgres', 'supabase_admin')
    and v_request_role = ''
  );
begin
  if tg_op = 'DELETE' then
    if old.status not in ('cancelled', 'no_show') then
      return old;
    end if;
    -- Terminal history is not a service-token cleanup surface.  A deliberate
    -- database retention run may still delete as postgres/supabase_admin; the
    -- self-referential recovery FK continues to RESTRICT source deletion while
    -- a canonical child exists.
    if v_privileged_owner_session then
      return old;
    end if;
    raise exception 'terminal booking hard delete requires a privileged retention workflow'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' and new.status in ('cancelled', 'no_show') then
    -- Direct SQL maintenance remains possible for postgres/supabase_admin. A
    -- PostgREST service token is not enough: production import/sync code must
    -- use an explicit transition/import workflow instead of forging history.
    if v_privileged_owner_session then
      return new;
    end if;
    raise exception 'direct terminal booking insert is not allowed'
      using errcode = '42501';
  end if;

  if tg_op <> 'UPDATE' then
    return new;
  end if;

  if old.status not in ('cancelled', 'no_show')
     and new.status in ('cancelled', 'no_show') then
    if v_request_role <> 'service_role'
       and not v_privileged_owner_session then
      raise exception 'terminal booking transition requires a trusted workflow'
        using errcode = '42501';
    end if;

    if not (
      v_transition_scope = new.id::text
      or v_transition_scope = 'group:' || coalesce(new.group_id::text, '')
    ) then
      raise exception 'terminal booking transition is missing its scoped authorization'
        using errcode = '42501';
    end if;

    if (
      to_jsonb(new) - array['status', 'no_show_candidate_at', 'updated_at']::text[]
    ) is distinct from (
      to_jsonb(old) - array['status', 'no_show_candidate_at', 'updated_at']::text[]
    ) then
      raise exception 'terminal entry may only change status and no-show candidate state'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.status in ('cancelled', 'no_show') then
    -- Privacy is independently shape-checked by
    -- validate_archived_booking_recovery(); this merely lets that service-only
    -- transaction reach the existing, stricter redaction exception.
    if current_setting('nailiq.privacy_redaction_booking_id', true) = old.id::text then
      if v_request_role <> 'service_role'
         and not v_privileged_owner_session then
        raise exception 'terminal privacy redaction requires service role'
          using errcode = '42501';
      end if;
      return new;
    end if;

    if v_fee_booking_id = old.id::text then
      if v_request_role <> 'service_role'
         and not v_privileged_owner_session then
        raise exception 'terminal fee mutation requires service role'
          using errcode = '42501';
      end if;
      if (
        to_jsonb(new) - array[
          'noshow_charge_status',
          'noshow_payment_id',
          'noshow_charge_attempts',
          'noshow_last_charge_attempt_at',
          'noshow_charge_error',
          'noshow_fee_cents',
          'noshow_fee_link_url',
          'noshow_fee_order_id',
          'noshow_card_id',
          'noshow_customer_id',
          'updated_at'
        ]::text[]
      ) is distinct from (
        to_jsonb(old) - array[
          'noshow_charge_status',
          'noshow_payment_id',
          'noshow_charge_attempts',
          'noshow_last_charge_attempt_at',
          'noshow_charge_error',
          'noshow_fee_cents',
          'noshow_fee_link_url',
          'noshow_fee_order_id',
          'noshow_card_id',
          'noshow_customer_id',
          'updated_at'
        ]::text[]
      ) then
        raise exception 'terminal fee workflow attempted an unrelated booking mutation'
          using errcode = '23514';
      end if;
      return new;
    end if;

    if to_jsonb(new) is distinct from to_jsonb(old) then
      raise exception 'terminal booking rows are immutable outside audited workflows'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.enforce_terminal_booking_write_boundary() is
  'Default-deny boundary for cancelled/no_show INSERT, entry, UPDATE and DELETE. Explicit service workflows set transaction-local scope; only postgres/supabase_admin retain deliberate terminal retention authority. Non-terminal DELETE behavior is unchanged.';

revoke all on function public.enforce_terminal_booking_write_boundary()
  from public, anon, authenticated, service_role;

drop trigger if exists enforce_terminal_booking_write_boundary_trigger
  on public.bookings;
create trigger enforce_terminal_booking_write_boundary_trigger
  before insert or update or delete on public.bookings
  for each row execute function public.enforce_terminal_booking_write_boundary();

-- One front-desk transition, with capability, tenant, source and prior-state
-- checks.  The server action calls this only after its own auth gate; the RPC
-- repeats the material checks and commits the transition audit atomically.
create or replace function public.transition_booking_to_terminal(
  p_booking_id uuid,
  p_salon_id uuid,
  p_actor_user_id uuid,
  p_actor_role text,
  p_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_actual_role text;
  v_booking public.bookings%rowtype;
  v_next_status text;
  v_event_id uuid;
begin
  if v_request_role <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'terminal transition requires service role'
      using errcode = '42501';
  end if;

  if p_booking_id is null or p_salon_id is null or p_actor_user_id is null
     or p_reason is null
     or p_reason not in ('walkin_removed', 'desk_cancel', 'wix_decline', 'desk_no_show') then
    return jsonb_build_object('success', false, 'code', 'invalid_request');
  end if;

  select sm.role into v_actual_role
    from public.salon_members sm
   where sm.salon_id = p_salon_id
     and sm.user_id = p_actor_user_id
     and sm.role in ('owner', 'admin', 'senior', 'receptionist');
  if not found or v_actual_role is distinct from p_actor_role then
    raise exception 'terminal transition actor lacks salon capability'
      using errcode = '42501';
  end if;

  select b.* into v_booking
    from public.bookings b
   where b.id = p_booking_id and b.salon_id = p_salon_id
   for update;
  if not found then
    return jsonb_build_object('success', false, 'code', 'invalid_state');
  end if;

  if p_reason = 'walkin_removed' then
    if v_booking.status <> 'waiting' or v_booking.source <> 'walkin' then
      return jsonb_build_object('success', false, 'code', 'invalid_state');
    end if;
    v_next_status := 'cancelled';
  elsif p_reason = 'desk_cancel' then
    if v_booking.status not in ('pending', 'confirmed', 'in_progress') then
      return jsonb_build_object('success', false, 'code', 'invalid_state');
    end if;
    v_next_status := 'cancelled';
  elsif p_reason = 'wix_decline' then
    if v_booking.status <> 'pending' or v_booking.wix_booking_id is null then
      return jsonb_build_object('success', false, 'code', 'invalid_state');
    end if;
    v_next_status := 'cancelled';
  else
    if v_booking.status not in ('confirmed', 'in_progress') then
      return jsonb_build_object('success', false, 'code', 'invalid_state');
    end if;
    v_next_status := 'no_show';
  end if;

  perform set_config('nailiq.terminal_transition_scope', p_booking_id::text, true);
  begin
    update public.bookings b
       set status = v_next_status,
           no_show_candidate_at = case
             when v_next_status = 'no_show' then null
             else b.no_show_candidate_at
           end
     where b.id = p_booking_id and b.salon_id = p_salon_id;

    insert into public.booking_events (
      booking_id, salon_id, actor_user_id, actor_role, event_type, payload
    ) values (
      p_booking_id,
      p_salon_id,
      p_actor_user_id,
      v_actual_role,
      'terminal_booking_transition_authorized',
      jsonb_build_object(
        'from', v_booking.status,
        'to', v_next_status,
        'reason', p_reason
      )
    ) returning id into v_event_id;
    if v_event_id is null then
      raise exception 'terminal transition audit insert failed';
    end if;
  exception when others then
    perform set_config('nailiq.terminal_transition_scope', '', true);
    raise;
  end;
  perform set_config('nailiq.terminal_transition_scope', '', true);

  return jsonb_build_object(
    'success', true,
    'booking', jsonb_build_object(
      'id', v_booking.id,
      'service_id', v_booking.service_id,
      'client_phone', v_booking.client_phone,
      'client_name', v_booking.client_name,
      'client_email', v_booking.client_email
    )
  );
end;
$$;

revoke all on function public.transition_booking_to_terminal(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.transition_booking_to_terminal(
  uuid, uuid, uuid, text, text
) to service_role;

create or replace function public.transition_booking_group_to_terminal(
  p_group_id uuid,
  p_salon_id uuid,
  p_actor_user_id uuid,
  p_actor_role text,
  p_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_actual_role text;
  v_ids uuid[];
  v_id uuid;
begin
  if v_request_role <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'terminal group transition requires service role'
      using errcode = '42501';
  end if;
  if p_reason is distinct from 'desk_group_cancel'
     or p_group_id is null or p_salon_id is null
     or p_actor_user_id is null then
    return jsonb_build_object('success', false, 'code', 'invalid_request');
  end if;
  select sm.role into v_actual_role
    from public.salon_members sm
   where sm.salon_id = p_salon_id
     and sm.user_id = p_actor_user_id
     and sm.role in ('owner', 'admin', 'senior', 'receptionist');
  if not found or v_actual_role is distinct from p_actor_role then
    raise exception 'terminal group transition actor lacks salon capability'
      using errcode = '42501';
  end if;

  select array_agg(locked.id order by locked.created_at, locked.id)
    into v_ids
    from (
      select b.id, b.created_at
        from public.bookings b
       where b.salon_id = p_salon_id
         and b.group_id = p_group_id
         and b.status in ('pending', 'confirmed', 'in_progress')
       for update
    ) locked;
  if coalesce(cardinality(v_ids), 0) = 0 then
    return jsonb_build_object('success', false, 'code', 'invalid_state');
  end if;

  perform set_config(
    'nailiq.terminal_transition_scope', 'group:' || p_group_id::text, true
  );
  begin
    update public.bookings b set status = 'cancelled'
     where b.id = any(v_ids);
    foreach v_id in array v_ids loop
      insert into public.booking_events (
        booking_id, salon_id, actor_user_id, actor_role, event_type, payload
      ) values (
        v_id, p_salon_id, p_actor_user_id, v_actual_role,
        'terminal_booking_transition_authorized',
        jsonb_build_object('to', 'cancelled', 'reason', p_reason, 'groupId', p_group_id)
      );
    end loop;
  exception when others then
    perform set_config('nailiq.terminal_transition_scope', '', true);
    raise;
  end;
  perform set_config('nailiq.terminal_transition_scope', '', true);
  return jsonb_build_object('success', true, 'booking_ids', to_jsonb(v_ids));
end;
$$;

revoke all on function public.transition_booking_group_to_terminal(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.transition_booking_group_to_terminal(
  uuid, uuid, uuid, text, text
) to service_role;

-- Record only the database outcome of a payment/card workflow.  Charging and
-- refunding occur outside PostgreSQL; this function cannot move money.  Every
-- accepted mutation and its non-PII audit commit or roll back together.
create or replace function public.record_terminal_booking_fee_mutation(
  p_booking_id uuid,
  p_salon_id uuid,
  p_operation text,
  p_request_id uuid,
  p_actor_user_id uuid default null,
  p_actor_role text default 'system',
  p_payment_id text default null,
  p_fee_cents integer default null,
  p_error text default null,
  p_link_url text default null,
  p_order_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_booking public.bookings%rowtype;
  v_actual_role text := 'system';
  v_event_id uuid;
  v_existing_operation text;
  v_existing_fingerprint text;
  v_request_fingerprint text;
begin
  if v_request_role <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'terminal fee mutation requires service role'
      using errcode = '42501';
  end if;
  if p_booking_id is null or p_salon_id is null or p_request_id is null
     or p_operation is null or p_operation not in (
       'charge_succeeded', 'charge_reconciled', 'charge_failed',
       'refund_succeeded', 'waive', 'card_removed',
       'payment_link_created', 'payment_link_paid'
     ) then
    return jsonb_build_object('success', false, 'code', 'invalid_request');
  end if;

  select b.* into v_booking
    from public.bookings b
   where b.id = p_booking_id and b.salon_id = p_salon_id
   for update;
  if not found or v_booking.status not in ('cancelled', 'no_show') then
    return jsonb_build_object('success', false, 'code', 'invalid_terminal_booking');
  end if;

  if p_actor_user_id is not null then
    select sm.role into v_actual_role
      from public.salon_members sm
     where sm.salon_id = p_salon_id
       and sm.user_id = p_actor_user_id
       and sm.role in ('owner', 'admin', 'senior', 'receptionist');
    if not found or v_actual_role is distinct from p_actor_role then
      raise exception 'terminal fee actor lacks salon capability'
        using errcode = '42501';
    end if;
  elsif p_actor_role <> 'system' then
    raise exception 'unattributed terminal fee mutation must use system role'
      using errcode = '42501';
  end if;

  -- Do not put payment/provider identifiers or error text in the audit row.
  -- Their canonical JSON hash is sufficient to distinguish an exact retry from
  -- a changed request which reuses the same idempotency UUID.
  v_request_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'bookingId', p_booking_id,
          'salonId', p_salon_id,
          'operation', p_operation,
          'actorUserId', p_actor_user_id,
          'actorRole', p_actor_role,
          'paymentId', p_payment_id,
          'feeCents', p_fee_cents,
          'error', p_error,
          'linkUrl', p_link_url,
          'orderId', p_order_id
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );

  select be.payload ->> 'operation', be.payload ->> 'requestFingerprint'
    into v_existing_operation, v_existing_fingerprint
    from public.booking_events be
     where be.booking_id = p_booking_id
       and be.salon_id = p_salon_id
       and be.event_type = 'terminal_booking_fee_mutation_recorded'
       and be.payload ->> 'requestId' = p_request_id::text
     limit 1;
  if found then
    if v_existing_operation is distinct from p_operation
       or v_existing_fingerprint is distinct from v_request_fingerprint then
      return jsonb_build_object(
        'success', false,
        'code', 'idempotency_mismatch'
      );
    end if;
    return jsonb_build_object(
      'success', true,
      'replayed', true,
      'charge_status', v_booking.noshow_charge_status
    );
  end if;

  perform set_config(
    'nailiq.terminal_fee_mutation_booking_id', p_booking_id::text, true
  );
  begin
    if p_operation in ('charge_succeeded', 'charge_reconciled') then
      if v_booking.noshow_charge_status in ('charged', 'refunded', 'waived')
         or v_booking.noshow_card_id is null
         or v_booking.noshow_consent_at is null
         or p_payment_id is null
         or coalesce(p_fee_cents, v_booking.noshow_fee_cents, 0) <= 0 then
        perform set_config('nailiq.terminal_fee_mutation_booking_id', '', true);
        return jsonb_build_object('success', false, 'code', 'invalid_state');
      end if;
      update public.bookings set
        noshow_charge_status = 'charged',
        noshow_payment_id = p_payment_id,
        noshow_fee_cents = coalesce(p_fee_cents, noshow_fee_cents),
        noshow_charge_attempts = coalesce(noshow_charge_attempts, 0) + 1,
        noshow_last_charge_attempt_at = clock_timestamp(),
        noshow_charge_error = null
      where id = p_booking_id;
    elsif p_operation = 'charge_failed' then
      if v_booking.noshow_charge_status in ('charged', 'refunded', 'waived')
         or v_booking.noshow_card_id is null
         or v_booking.noshow_consent_at is null then
        perform set_config('nailiq.terminal_fee_mutation_booking_id', '', true);
        return jsonb_build_object('success', false, 'code', 'invalid_state');
      end if;
      update public.bookings set
        noshow_charge_status = 'failed',
        noshow_payment_id = coalesce(p_payment_id, noshow_payment_id),
        noshow_charge_attempts = coalesce(noshow_charge_attempts, 0) + 1,
        noshow_last_charge_attempt_at = clock_timestamp(),
        noshow_charge_error = left(coalesce(p_error, 'charge_failed'), 500)
      where id = p_booking_id;
    elsif p_operation = 'refund_succeeded' then
      if v_booking.noshow_charge_status <> 'charged' then
        perform set_config('nailiq.terminal_fee_mutation_booking_id', '', true);
        return jsonb_build_object('success', false, 'code', 'invalid_state');
      end if;
      update public.bookings set noshow_charge_status = 'refunded'
       where id = p_booking_id;
    elsif p_operation = 'waive' then
      if v_booking.status <> 'no_show'
         or v_booking.noshow_charge_status in ('charged', 'refunded')
         or p_actor_user_id is null then
        perform set_config('nailiq.terminal_fee_mutation_booking_id', '', true);
        return jsonb_build_object('success', false, 'code', 'invalid_state');
      end if;
      update public.bookings set noshow_charge_status = 'waived'
       where id = p_booking_id;
    elsif p_operation = 'card_removed' then
      if v_booking.noshow_charge_status in ('charged', 'refunded') then
        perform set_config('nailiq.terminal_fee_mutation_booking_id', '', true);
        return jsonb_build_object('success', false, 'code', 'invalid_state');
      end if;
      update public.bookings set
        noshow_card_id = null,
        noshow_customer_id = null,
        noshow_charge_status = 'removed_by_customer'
      where id = p_booking_id;
    elsif p_operation = 'payment_link_created' then
      if v_booking.noshow_charge_status in ('charged', 'refunded')
         or p_link_url is null or p_order_id is null then
        perform set_config('nailiq.terminal_fee_mutation_booking_id', '', true);
        return jsonb_build_object('success', false, 'code', 'invalid_state');
      end if;
      update public.bookings set
        noshow_fee_link_url = p_link_url,
        noshow_fee_order_id = p_order_id
      where id = p_booking_id;
    else
      if v_booking.noshow_charge_status in ('charged', 'refunded')
         or p_payment_id is null then
        perform set_config('nailiq.terminal_fee_mutation_booking_id', '', true);
        return jsonb_build_object('success', false, 'code', 'invalid_state');
      end if;
      update public.bookings set
        noshow_charge_status = 'charged',
        noshow_payment_id = p_payment_id,
        noshow_charge_error = null
      where id = p_booking_id;
    end if;

    insert into public.booking_events (
      booking_id, salon_id, actor_user_id, actor_role, event_type, payload
    ) values (
      p_booking_id,
      p_salon_id,
      p_actor_user_id,
      v_actual_role,
      'terminal_booking_fee_mutation_recorded',
      jsonb_build_object(
        'requestId', p_request_id,
        'requestFingerprint', v_request_fingerprint,
        'operation', p_operation,
        'from', v_booking.noshow_charge_status,
        'to', (select b.noshow_charge_status from public.bookings b where b.id = p_booking_id)
      )
    ) returning id into v_event_id;
    if v_event_id is null then
      raise exception 'terminal fee audit insert failed';
    end if;
  exception when others then
    perform set_config('nailiq.terminal_fee_mutation_booking_id', '', true);
    raise;
  end;
  perform set_config('nailiq.terminal_fee_mutation_booking_id', '', true);

  return jsonb_build_object(
    'success', true,
    'replayed', false,
    'charge_status', (select b.noshow_charge_status from public.bookings b where b.id = p_booking_id)
  );
end;
$$;

revoke all on function public.record_terminal_booking_fee_mutation(
  uuid, uuid, text, uuid, uuid, text, text, integer, text, text, text
) from public, anon, authenticated;
grant execute on function public.record_terminal_booking_fee_mutation(
  uuid, uuid, text, uuid, uuid, text, text, integer, text, text, text
) to service_role;

-- Existing service-only customer/automation RPCs now set the same narrow
-- transaction-local scope before entering a terminal status.
create or replace function public.cancel_booking_as_customer(p_token_id uuid)
returns table(ok boolean, code text, booking_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token public.booking_reminder_tokens%rowtype;
  v_booking public.bookings%rowtype;
  v_tz text;
  v_future boolean;
  v_event_id uuid;
begin
  select * into v_token from public.booking_reminder_tokens
   where id = p_token_id and used_at is null and expires_at > now()
   for update;
  if not found then
    return query select false, 'token_invalid'::text, null::uuid;
    return;
  end if;
  select * into v_booking from public.bookings
   where id = v_token.booking_id and status in ('pending', 'confirmed')
   for update;
  if not found then
    return query select false, 'booking_not_cancellable'::text, null::uuid;
    return;
  end if;
  perform set_config('nailiq.terminal_transition_scope', v_booking.id::text, true);
  begin
    update public.bookings set status = 'cancelled' where id = v_booking.id;
    insert into public.booking_events (
      booking_id, salon_id, actor_user_id, actor_role, event_type, payload
    ) values (
      v_booking.id, v_booking.salon_id, null, 'public_guest',
      'terminal_booking_transition_authorized',
      jsonb_build_object(
        'from', v_booking.status,
        'to', 'cancelled',
        'reason', 'customer_token_cancel'
      )
    ) returning id into v_event_id;
    if v_event_id is null then
      raise exception 'customer terminal transition audit insert failed';
    end if;
  exception when others then
    perform set_config('nailiq.terminal_transition_scope', '', true);
    raise;
  end;
  perform set_config('nailiq.terminal_transition_scope', '', true);
  update public.booking_reminder_tokens
     set used_at = now(), used_action = 'cancel' where id = v_token.id;
  select coalesce(nullif(trim(s.timezone), ''), 'America/Los_Angeles')
    into v_tz from public.salons s where s.id = v_booking.salon_id;
  v_tz := coalesce(v_tz, 'America/Los_Angeles');
  v_future := v_booking.start_time_utc > now();
  update public.booking_waitlist_entries set
    status = 'notified', notified_at = now(), claim_token = gen_random_uuid(),
    offered_staff_id = case when v_future then v_booking.staff_id end,
    offered_start_utc = case when v_future then v_booking.start_time_utc end,
    offered_end_utc = case when v_future then v_booking.end_time_utc end
  where id = (
    select id from public.booking_waitlist_entries
     where salon_id = v_booking.salon_id
       and service_id = v_booking.service_id
       and booking_date = (v_booking.start_time_utc at time zone v_tz)::date
       and status = 'waiting'
     order by created_at limit 1 for update skip locked
  );
  return query select true, 'ok'::text, v_booking.id;
end;
$$;

revoke all on function public.cancel_booking_as_customer(uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_booking_as_customer(uuid) to service_role;

-- Trusted customer-channel cancellation still has to name its tenant.  The
-- previous booking-id-only overload is revoked below so an internal caller
-- cannot accidentally cancel a row from a different salon merely because it
-- learned a UUID.
create or replace function public.cancel_booking_by_id(
  p_booking_id uuid,
  p_salon_id uuid
)
returns table(ok boolean, code text, booking_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype;
  v_tz text;
  v_future boolean;
  v_event_id uuid;
begin
  if p_booking_id is null or p_salon_id is null then
    return query select false, 'invalid_request'::text, null::uuid;
    return;
  end if;
  select * into v_booking from public.bookings
   where id = p_booking_id
     and salon_id = p_salon_id
     and status in ('pending', 'confirmed')
   for update;
  if not found then
    return query select false, 'booking_not_cancellable'::text, null::uuid;
    return;
  end if;
  perform set_config('nailiq.terminal_transition_scope', v_booking.id::text, true);
  begin
    update public.bookings set status = 'cancelled' where id = v_booking.id;
    insert into public.booking_events (
      booking_id, salon_id, actor_user_id, actor_role, event_type, payload
    ) values (
      v_booking.id, v_booking.salon_id, null, 'system',
      'terminal_booking_transition_authorized',
      jsonb_build_object(
        'from', v_booking.status,
        'to', 'cancelled',
        'reason', 'system_cancel_by_id'
      )
    ) returning id into v_event_id;
    if v_event_id is null then
      raise exception 'system terminal transition audit insert failed';
    end if;
  exception when others then
    perform set_config('nailiq.terminal_transition_scope', '', true);
    raise;
  end;
  perform set_config('nailiq.terminal_transition_scope', '', true);
  select coalesce(nullif(trim(s.timezone), ''), 'America/Los_Angeles')
    into v_tz from public.salons s where s.id = v_booking.salon_id;
  v_tz := coalesce(v_tz, 'America/Los_Angeles');
  v_future := v_booking.start_time_utc > now();
  update public.booking_waitlist_entries set
    status = 'notified', notified_at = now(), claim_token = gen_random_uuid(),
    offered_staff_id = case when v_future then v_booking.staff_id end,
    offered_start_utc = case when v_future then v_booking.start_time_utc end,
    offered_end_utc = case when v_future then v_booking.end_time_utc end
  where id = (
    select id from public.booking_waitlist_entries
     where salon_id = v_booking.salon_id
       and service_id = v_booking.service_id
       and booking_date = (v_booking.start_time_utc at time zone v_tz)::date
       and status = 'waiting'
     order by created_at limit 1 for update skip locked
  );
  return query select true, 'ok'::text, v_booking.id;
end;
$$;

-- The historical booking-id-only capability is deliberately unavailable to
-- every PostgREST role.  Database owners retain only their ordinary direct SQL
-- ownership privilege for maintenance.
revoke all on function public.cancel_booking_by_id(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.cancel_booking_by_id(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_booking_by_id(uuid, uuid)
  to service_role;

-- Square-origin terminal statuses arrive from a trusted polling worker without
-- a human salon-member actor.  Bind the capability to the tenant, NailIQ row,
-- and already-linked Square booking id; accept only an active source row and
-- commit the status plus non-PII audit in one transaction.
create or replace function public.transition_square_booking_to_terminal(
  p_booking_id uuid,
  p_salon_id uuid,
  p_square_booking_id text,
  p_target_status text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_booking public.bookings%rowtype;
  v_event_id uuid;
begin
  if v_request_role <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'Square terminal transition requires service role'
      using errcode = '42501';
  end if;
  if p_booking_id is null or p_salon_id is null
     or length(trim(coalesce(p_square_booking_id, ''))) = 0
     or p_target_status is null
     or p_target_status not in ('cancelled', 'no_show') then
    return jsonb_build_object('success', false, 'code', 'invalid_request');
  end if;

  select b.* into v_booking
    from public.bookings b
   where b.id = p_booking_id
     and b.salon_id = p_salon_id
     and b.square_booking_id = p_square_booking_id
     and b.status in ('pending', 'confirmed')
   for update;
  if not found then
    return jsonb_build_object('success', false, 'code', 'invalid_state');
  end if;

  perform set_config('nailiq.terminal_transition_scope', p_booking_id::text, true);
  begin
    update public.bookings b
       set status = p_target_status,
           no_show_candidate_at = case
             when p_target_status = 'no_show' then null
             else b.no_show_candidate_at
           end
     where b.id = p_booking_id and b.salon_id = p_salon_id;

    insert into public.booking_events (
      booking_id, salon_id, actor_user_id, actor_role, event_type, payload
    ) values (
      p_booking_id, p_salon_id, null, 'system',
      'terminal_booking_transition_authorized',
      jsonb_build_object(
        'from', v_booking.status,
        'to', p_target_status,
        'reason', case
          when p_target_status = 'no_show' then 'square_sync_no_show'
          else 'square_sync_cancel'
        end,
        'provider', 'square'
      )
    ) returning id into v_event_id;
    if v_event_id is null then
      raise exception 'Square terminal transition audit insert failed';
    end if;
  exception when others then
    perform set_config('nailiq.terminal_transition_scope', '', true);
    raise;
  end;
  perform set_config('nailiq.terminal_transition_scope', '', true);

  return jsonb_build_object(
    'success', true,
    'booking_id', p_booking_id,
    'status', p_target_status
  );
end;
$$;

revoke all on function public.transition_square_booking_to_terminal(
  uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.transition_square_booking_to_terminal(
  uuid, uuid, text, text
) to service_role;

create or replace function public.cancel_booking_group_as_system(
  p_group_id uuid,
  p_salon_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_ids uuid[];
  v_id uuid;
begin
  if v_request_role <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'system group cancellation requires service role'
      using errcode = '42501';
  end if;
  select array_agg(locked.id order by locked.created_at, locked.id)
    into v_ids
    from (
      select b.id, b.created_at from public.bookings b
       where b.salon_id = p_salon_id
         and b.group_id = p_group_id
         and b.status in ('pending', 'confirmed')
       for update
    ) locked;
  if coalesce(cardinality(v_ids), 0) = 0 then
    return jsonb_build_object('success', false, 'code', 'invalid_state');
  end if;
  perform set_config(
    'nailiq.terminal_transition_scope', 'group:' || p_group_id::text, true
  );
  begin
    update public.bookings set status = 'cancelled' where id = any(v_ids);
    foreach v_id in array v_ids loop
      insert into public.booking_events (
        booking_id, salon_id, actor_user_id, actor_role, event_type, payload
      ) values (
        v_id, p_salon_id, null, 'system',
        'terminal_booking_transition_authorized',
        jsonb_build_object('to', 'cancelled', 'reason', 'voice_ai_group_cancel')
      );
    end loop;
  exception when others then
    perform set_config('nailiq.terminal_transition_scope', '', true);
    raise;
  end;
  perform set_config('nailiq.terminal_transition_scope', '', true);
  return jsonb_build_object('success', true, 'booking_ids', to_jsonb(v_ids));
end;
$$;

revoke all on function public.cancel_booking_group_as_system(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_booking_group_as_system(uuid, uuid)
  to service_role;

create or replace function public.auto_mark_no_shows()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  -- Preserve the human-review policy introduced by
  -- 20260731100828_no_show_candidate_confirmation: automation may flag an
  -- overdue confirmed booking, but it may not decide attendance, charge, or
  -- enter a terminal state. A desk role must still explicitly acknowledge it.
  with flagged as (
    update public.bookings b set no_show_candidate_at = now()
      from public.salons s
     where b.salon_id = s.id
       and s.auto_no_show_minutes is not null
       and s.auto_no_show_minutes > 0
       and b.status = 'confirmed'
       and b.no_show_candidate_at is null
       and b.start_time_utc < now() - (s.auto_no_show_minutes || ' minutes')::interval
    returning 1
  ) select count(*)::integer into v_count from flagged;
  return v_count;
end;
$$;

comment on function public.auto_mark_no_shows() is
  'Idempotently flags overdue confirmed bookings for human no-show review. Never changes booking status, charges a fee, or increments client no-show history.';

revoke all on function public.auto_mark_no_shows()
  from public, anon, authenticated;
grant execute on function public.auto_mark_no_shows() to service_role;
