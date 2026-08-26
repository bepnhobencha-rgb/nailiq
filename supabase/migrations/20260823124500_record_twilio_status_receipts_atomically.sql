-- MQA-0101/0197: bind Twilio terminal receipts to the exact accepted SMS.
-- Reminder completion creates the callback correlation row in the same
-- transaction; the callback RPC serializes replay/conflict handling.

alter table public.booking_reminder_delivery_claims
  add column if not exists delivery_status text,
  add column if not exists delivery_error_code text,
  add column if not exists delivery_received_at timestamptz,
  add column if not exists delivery_fingerprint text;

alter table public.staff_action_notification_deliveries
  add column if not exists delivery_status text,
  add column if not exists delivery_error_code text,
  add column if not exists delivery_received_at timestamptz,
  add column if not exists delivery_fingerprint text;

create table if not exists public.twilio_message_status_receipts (
  message_sid text primary key,
  terminal_status text not null,
  error_code text,
  receipt_fingerprint text not null,
  received_at timestamptz not null default transaction_timestamp(),
  applied_at timestamptz,
  notification_id uuid references public.booking_notifications(id) on delete set null,
  reminder_claim_id uuid references public.booking_reminder_delivery_claims(id) on delete set null,
  conflict_status text,
  conflict_error_code text,
  conflict_fingerprint text,
  conflict_recorded_at timestamptz,
  constraint twilio_message_status_receipts_sid_check
    check (message_sid ~ '^(SM|MM)[0-9A-Fa-f]{32}$'),
  constraint twilio_message_status_receipts_terminal_check
    check (terminal_status in ('delivered', 'undelivered', 'failed')),
  constraint twilio_message_status_receipts_error_check
    check (
      (error_code is null or error_code ~ '^[0-9]{3,8}$')
      and (terminal_status <> 'delivered' or error_code is null)
    ),
  constraint twilio_message_status_receipts_fingerprint_check
    check (receipt_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint twilio_message_status_receipts_conflict_check
    check (
      (
        conflict_status is null
        and conflict_error_code is null
        and conflict_fingerprint is null
        and conflict_recorded_at is null
      )
      or (
        conflict_status in ('delivered', 'undelivered', 'failed')
        and conflict_fingerprint ~ '^[0-9a-f]{64}$'
        and conflict_recorded_at is not null
        and (conflict_error_code is null or conflict_error_code ~ '^[0-9]{3,8}$')
        and (conflict_status <> 'delivered' or conflict_error_code is null)
      )
    )
);

alter table public.twilio_message_status_receipts
  add column if not exists staff_action_delivery_id uuid
    references public.staff_action_notification_deliveries(id) on delete set null;

alter table public.twilio_message_status_receipts
  drop constraint if exists twilio_message_status_receipts_application_check;
alter table public.twilio_message_status_receipts
  add constraint twilio_message_status_receipts_application_check
  check (
    (
      applied_at is null
      and notification_id is null
      and reminder_claim_id is null
      and staff_action_delivery_id is null
    )
    or applied_at is not null
  );

alter table public.twilio_message_status_receipts enable row level security;
alter table public.twilio_message_status_receipts force row level security;
revoke all privileges on table public.twilio_message_status_receipts
  from public, anon, authenticated;
grant all privileges on table public.twilio_message_status_receipts
  to service_role;

do $constraints$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.booking_reminder_delivery_claims'::regclass
      and conname = 'booking_reminder_delivery_claims_delivery_receipt_check'
  ) then
    alter table public.booking_reminder_delivery_claims
      add constraint booking_reminder_delivery_claims_delivery_receipt_check
      check (
        (
          delivery_status is null
          and delivery_error_code is null
          and delivery_received_at is null
          and delivery_fingerprint is null
        )
        or (
          status = 'sent'
          and delivery_status in ('delivered', 'undelivered', 'failed')
          and delivery_received_at is not null
          and (
            delivery_error_code is null
            or delivery_error_code ~ '^[0-9]{3,8}$'
          )
          and (delivery_status <> 'delivered' or delivery_error_code is null)
          and delivery_fingerprint ~ '^[0-9a-f]{64}$'
        )
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.booking_reminder_delivery_claims'::regclass
      and conname = 'booking_reminder_delivery_claims_sms_sid_check'
  ) then
    alter table public.booking_reminder_delivery_claims
      add constraint booking_reminder_delivery_claims_sms_sid_check
      check (
        channel <> 'sms'
        or provider_message_id is null
        or provider_message_id ~ '^(SM|MM)[0-9A-Fa-f]{32}$'
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.staff_action_notification_deliveries'::regclass
      and conname = 'staff_action_notification_deliveries_delivery_receipt_check'
  ) then
    alter table public.staff_action_notification_deliveries
      add constraint staff_action_notification_deliveries_delivery_receipt_check
      check (
        (
          delivery_status is null
          and delivery_error_code is null
          and delivery_received_at is null
          and delivery_fingerprint is null
        )
        or (
          status = 'sent'
          and channel = 'sms'
          and provider_name = 'twilio'
          and provider_message_id ~ '^(SM|MM)[0-9A-Fa-f]{32}$'
          and delivery_status in ('delivered', 'undelivered', 'failed')
          and delivery_received_at is not null
          and (
            delivery_error_code is null
            or delivery_error_code ~ '^[0-9]{3,8}$'
          )
          and (delivery_status <> 'delivered' or delivery_error_code is null)
          and delivery_fingerprint ~ '^[0-9a-f]{64}$'
        )
      ) not valid;
  end if;
end;
$constraints$;

create unique index if not exists booking_reminder_delivery_claims_sms_sid_unique
  on public.booking_reminder_delivery_claims (provider_message_id)
  where channel = 'sms' and provider_message_id is not null;

create unique index if not exists staff_action_notification_deliveries_sms_sid_unique
  on public.staff_action_notification_deliveries (provider_message_id)
  where channel = 'sms' and provider_message_id is not null;

create or replace function public.complete_booking_reminder_delivery(
  p_claim_id uuid,
  p_status text,
  p_provider_message_id text default null,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $complete$
declare
  v_claim public.booking_reminder_delivery_claims%rowtype;
  v_notification public.booking_notifications%rowtype;
  v_pending_receipt public.twilio_message_status_receipts%rowtype;
  v_provider_message_id text := nullif(trim(coalesce(p_provider_message_id, '')), '');
  v_error_code text := nullif(lower(trim(coalesce(p_error_code, ''))), '');
  v_notification_type text;
  v_apply jsonb;
begin
  if p_claim_id is null
     or p_status not in ('sent', 'failed', 'unknown', 'suppressed')
     or (p_status = 'sent' and v_provider_message_id is null)
     or (
       v_provider_message_id is not null
       and (
         length(v_provider_message_id) > 200
         or v_provider_message_id ~ '[[:cntrl:]]'
       )
     )
     or (v_error_code is not null and v_error_code !~ '^[a-z0-9_:-]{1,160}$') then
    return jsonb_build_object('success', false, 'code', 'invalid_completion');
  end if;

  if p_status = 'sent'
     and v_provider_message_id ~ '^(SM|MM)[0-9A-Fa-f]{32}$' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_provider_message_id, 1040197)
    );
  end if;

  select c.*
  into v_claim
  from public.booking_reminder_delivery_claims c
  where c.id = p_claim_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'code', 'claim_not_found');
  end if;

  if p_status = 'sent'
     and v_claim.channel = 'sms'
     and v_provider_message_id !~ '^(SM|MM)[0-9A-Fa-f]{32}$' then
    return jsonb_build_object('success', false, 'code', 'invalid_completion');
  end if;

  if v_claim.status <> 'sending' then
    if v_claim.status = p_status
       and v_claim.provider_message_id is not distinct from v_provider_message_id
       and v_claim.last_error_code is not distinct from v_error_code then
      return jsonb_build_object(
        'success', true,
        'code', 'already_completed',
        'status', v_claim.status
      );
    end if;
    return jsonb_build_object(
      'success', false,
      'code', 'completion_conflict',
      'status', v_claim.status
    );
  end if;

  if p_status = 'sent' and v_claim.channel = 'sms' then
    v_notification_type := case v_claim.reminder_type
      when '24h' then 'reminder_24h'
      when '3h' then 'reminder_3h'
    end;

    select n.*
    into v_notification
    from public.booking_notifications n
    where n.twilio_message_sid = v_provider_message_id
    for update;

    if found and (
      v_notification.booking_id is distinct from v_claim.booking_id
      or v_notification.salon_id is distinct from v_claim.salon_id
      or v_notification.notification_type is distinct from v_notification_type
      or v_notification.channel is distinct from 'sms'
    ) then
      return jsonb_build_object('success', false, 'code', 'receipt_identity_conflict');
    end if;
  end if;

  update public.booking_reminder_delivery_claims c
  set status = p_status,
      provider_message_id = v_provider_message_id,
      last_error_code = v_error_code,
      completed_at = transaction_timestamp(),
      updated_at = transaction_timestamp()
  where c.id = p_claim_id;

  if p_status = 'sent' and v_claim.channel = 'sms' then
    insert into public.booking_notifications (
      booking_id,
      salon_id,
      notification_type,
      channel,
      status,
      twilio_message_sid,
      sent_at,
      delivered_at,
      failed_at,
      error_code
    ) values (
      v_claim.booking_id,
      v_claim.salon_id,
      v_notification_type,
      'sms',
      'sent',
      v_provider_message_id,
      transaction_timestamp(),
      null,
      null,
      null
    )
    on conflict (twilio_message_sid) do nothing;

    select n.*
    into v_notification
    from public.booking_notifications n
    where n.twilio_message_sid = v_provider_message_id;

    if not found or (
      v_notification.booking_id is distinct from v_claim.booking_id
      or v_notification.salon_id is distinct from v_claim.salon_id
      or v_notification.notification_type is distinct from v_notification_type
      or v_notification.channel is distinct from 'sms'
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'twilio reminder receipt identity conflict';
    end if;

    select r.*
    into v_pending_receipt
    from public.twilio_message_status_receipts r
    where r.message_sid = v_provider_message_id;

    if found and v_pending_receipt.applied_at is null then
      execute
        'select public.record_twilio_message_status_receipt($1,$2,$3)'
        into v_apply
        using
          v_pending_receipt.message_sid,
          v_pending_receipt.terminal_status,
          v_pending_receipt.error_code;
      if v_apply->>'success' <> 'true' then
        raise exception using
          errcode = 'P0001',
          message = 'pending twilio reminder receipt application failed';
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'success', true,
    'code', 'completed',
    'status', p_status
  );
end;
$complete$;

create or replace function public.record_twilio_message_status_receipt(
  p_message_sid text,
  p_status text,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $record$
declare
  v_message_sid text := trim(coalesce(p_message_sid, ''));
  v_status text := lower(trim(coalesce(p_status, '')));
  v_error_code text := nullif(trim(coalesce(p_error_code, '')), '');
  v_notification public.booking_notifications%rowtype;
  v_claim public.booking_reminder_delivery_claims%rowtype;
  v_staff_delivery public.staff_action_notification_deliveries%rowtype;
  v_receipt public.twilio_message_status_receipts%rowtype;
  v_notification_type text;
  v_fingerprint text;
begin
  if not public.staff_action_notification_caller_is_service_role() then
    return jsonb_build_object('success', false, 'code', 'unauthorized');
  end if;

  if v_message_sid !~ '^(SM|MM)[0-9A-Fa-f]{32}$'
     or v_status not in ('delivered', 'undelivered', 'failed')
     or (v_error_code is not null and v_error_code !~ '^[0-9]{3,8}$')
     or (v_status = 'delivered' and v_error_code is not null) then
    return jsonb_build_object('success', false, 'code', 'invalid_receipt');
  end if;

  v_fingerprint := pg_catalog.encode(
    extensions.digest(
      v_message_sid || ':' || v_status || ':' || coalesce(v_error_code, ''),
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_message_sid, 1040197)
  );

  insert into public.twilio_message_status_receipts (
    message_sid,
    terminal_status,
    error_code,
    receipt_fingerprint
  ) values (
    v_message_sid,
    v_status,
    v_error_code,
    v_fingerprint
  )
  on conflict (message_sid) do nothing;

  select r.*
  into v_receipt
  from public.twilio_message_status_receipts r
  where r.message_sid = v_message_sid
  for update;

  if v_receipt.receipt_fingerprint is distinct from v_fingerprint then
    update public.twilio_message_status_receipts r
    set conflict_status = coalesce(r.conflict_status, v_status),
        conflict_error_code = case
          when r.conflict_fingerprint is null then v_error_code
          else r.conflict_error_code
        end,
        conflict_fingerprint = coalesce(r.conflict_fingerprint, v_fingerprint),
        conflict_recorded_at = coalesce(r.conflict_recorded_at, transaction_timestamp())
    where r.message_sid = v_message_sid;

    return jsonb_build_object(
      'success', true,
      'code', 'durable_conflict',
      'status', v_receipt.terminal_status
    );
  end if;

  if v_receipt.applied_at is not null then
    return jsonb_build_object(
      'success', true,
      'code', 'exact_replay',
      'status', v_receipt.terminal_status,
      'notification_id', v_receipt.notification_id,
      'reminder_claim_id', v_receipt.reminder_claim_id,
      'staff_action_delivery_id', v_receipt.staff_action_delivery_id
    );
  end if;

  select n.*
  into v_notification
  from public.booking_notifications n
  where n.twilio_message_sid = v_message_sid
  for update;

  select c.*
  into v_claim
  from public.booking_reminder_delivery_claims c
  where c.channel = 'sms'
    and c.provider_message_id = v_message_sid
  for update;

  select d.*
  into v_staff_delivery
  from public.staff_action_notification_deliveries d
  where d.channel = 'sms'
    and d.provider_name = 'twilio'
    and d.provider_message_id = v_message_sid
  for update;

  if v_staff_delivery.id is not null
     and (v_notification.id is not null or v_claim.id is not null) then
    return jsonb_build_object(
      'success', true,
      'code', 'pending',
      'status', v_status,
      'reason', 'correlation_identity_conflict'
    );
  end if;

  if v_notification.id is null
     and v_claim.id is null
     and v_staff_delivery.id is null then
    return jsonb_build_object(
      'success', true,
      'code', 'pending',
      'status', v_status
    );
  end if;

  if v_claim.id is not null then
    if v_claim.status <> 'sent' then
      return jsonb_build_object(
        'success', true,
        'code', 'pending',
        'status', v_status,
        'reason', 'claim_not_accepted'
      );
    end if;
    v_notification_type := case v_claim.reminder_type
      when '24h' then 'reminder_24h'
      when '3h' then 'reminder_3h'
    end;

    if v_notification.id is null then
      insert into public.booking_notifications (
        booking_id,
        salon_id,
        notification_type,
        channel,
        status,
        twilio_message_sid,
        sent_at
      ) values (
        v_claim.booking_id,
        v_claim.salon_id,
        v_notification_type,
        'sms',
        'sent',
        v_message_sid,
        v_claim.completed_at
      )
      on conflict (twilio_message_sid) do nothing;

      select n.*
      into v_notification
      from public.booking_notifications n
      where n.twilio_message_sid = v_message_sid
      for update;
    end if;

    if v_notification.id is null or (
      v_notification.booking_id is distinct from v_claim.booking_id
      or v_notification.salon_id is distinct from v_claim.salon_id
      or v_notification.notification_type is distinct from v_notification_type
      or v_notification.channel is distinct from 'sms'
    ) then
      return jsonb_build_object(
        'success', true,
        'code', 'pending',
        'status', v_status,
        'reason', 'receipt_identity_conflict'
      );
    end if;
  end if;

  if v_notification.id is not null then
    if v_notification.status in ('delivered', 'undelivered', 'failed') and (
      v_notification.status is distinct from v_status
      or v_notification.error_code is distinct from v_error_code
    ) then
      update public.twilio_message_status_receipts r
      set conflict_status = coalesce(r.conflict_status, v_notification.status),
          conflict_error_code = case
            when r.conflict_fingerprint is null then v_notification.error_code
            else r.conflict_error_code
          end,
          conflict_fingerprint = coalesce(
            r.conflict_fingerprint,
            pg_catalog.encode(
              extensions.digest(
                v_message_sid || ':' || v_notification.status || ':' ||
                  coalesce(v_notification.error_code, ''),
                'sha256'
              ),
              'hex'
            )
          ),
          conflict_recorded_at = coalesce(r.conflict_recorded_at, transaction_timestamp())
      where r.message_sid = v_message_sid;
      return jsonb_build_object('success', true, 'code', 'durable_conflict');
    end if;

    if v_notification.status not in (
      'sending', 'sent', 'unknown', 'delivered', 'undelivered', 'failed'
    ) then
      return jsonb_build_object(
        'success', true,
        'code', 'pending',
        'status', v_status,
        'reason', 'notification_not_accepted'
      );
    end if;
  end if;

  if v_claim.id is not null and v_claim.delivery_status is not null and (
    v_claim.delivery_status is distinct from v_status
    or v_claim.delivery_error_code is distinct from v_error_code
    or v_claim.delivery_fingerprint is distinct from v_fingerprint
  ) then
    update public.twilio_message_status_receipts r
    set conflict_status = coalesce(r.conflict_status, v_claim.delivery_status),
        conflict_error_code = case
          when r.conflict_fingerprint is null then v_claim.delivery_error_code
          else r.conflict_error_code
        end,
        conflict_fingerprint = coalesce(r.conflict_fingerprint, v_claim.delivery_fingerprint),
        conflict_recorded_at = coalesce(r.conflict_recorded_at, transaction_timestamp())
    where r.message_sid = v_message_sid;
    return jsonb_build_object('success', true, 'code', 'durable_conflict');
  end if;

  if v_staff_delivery.id is not null then
    if v_staff_delivery.status <> 'sent' then
      return jsonb_build_object(
        'success', true,
        'code', 'pending',
        'status', v_status,
        'reason', 'staff_delivery_not_accepted'
      );
    end if;

    if v_staff_delivery.delivery_status is not null and (
      v_staff_delivery.delivery_status is distinct from v_status
      or v_staff_delivery.delivery_error_code is distinct from v_error_code
      or v_staff_delivery.delivery_fingerprint is distinct from v_fingerprint
    ) then
      update public.twilio_message_status_receipts r
      set conflict_status = coalesce(r.conflict_status, v_staff_delivery.delivery_status),
          conflict_error_code = case
            when r.conflict_fingerprint is null then v_staff_delivery.delivery_error_code
            else r.conflict_error_code
          end,
          conflict_fingerprint = coalesce(
            r.conflict_fingerprint,
            v_staff_delivery.delivery_fingerprint
          ),
          conflict_recorded_at = coalesce(
            r.conflict_recorded_at,
            transaction_timestamp()
          )
      where r.message_sid = v_message_sid;
      return jsonb_build_object('success', true, 'code', 'durable_conflict');
    end if;

  end if;

  -- All correlated rows have passed identity/state/conflict checks. Apply the
  -- first terminal truth to every target only after that preflight succeeds.
  if v_notification.id is not null
     and v_notification.status not in ('delivered', 'undelivered', 'failed') then
    update public.booking_notifications n
    set status = v_status,
        delivered_at = case when v_status = 'delivered' then transaction_timestamp() else null end,
        failed_at = case when v_status <> 'delivered' then transaction_timestamp() else null end,
        error_code = v_error_code
    where n.id = v_notification.id;
  end if;

  if v_claim.id is not null and v_claim.delivery_status is null then
    update public.booking_reminder_delivery_claims c
    set delivery_status = v_status,
        delivery_error_code = v_error_code,
        delivery_received_at = transaction_timestamp(),
        delivery_fingerprint = v_fingerprint,
        updated_at = transaction_timestamp()
    where c.id = v_claim.id;
  end if;

  if v_staff_delivery.id is not null
     and v_staff_delivery.delivery_status is null then
    update public.staff_action_notification_deliveries d
    set delivery_status = v_status,
        delivery_error_code = v_error_code,
        delivery_received_at = transaction_timestamp(),
        delivery_fingerprint = v_fingerprint,
        updated_at = transaction_timestamp()
    where d.id = v_staff_delivery.id;
  end if;

  update public.twilio_message_status_receipts r
  set applied_at = transaction_timestamp(),
      notification_id = v_notification.id,
      reminder_claim_id = v_claim.id,
      staff_action_delivery_id = v_staff_delivery.id
  where r.message_sid = v_message_sid;

  return jsonb_build_object(
    'success', true,
    'code', 'applied',
    'status', v_status,
    'notification_id', v_notification.id,
    'reminder_claim_id', v_claim.id,
    'staff_action_delivery_id', v_staff_delivery.id
  );
end;
$record$;

-- A provider callback can win the race before a generic notification or a
-- staff-action completion stores its SID. The correlation-row write drains the
-- pending inbox. Twilio-aware completion RPCs acquire this same SID lock before
-- their row locks; direct generic inserts/updates expose no matching SID before
-- this trigger, so waiting here cannot form the inverse callback lock cycle.
create or replace function public.apply_pending_twilio_receipt_after_correlation()
returns trigger
language plpgsql
security definer
set search_path to ''
as $apply_pending$
declare
  v_message_sid text;
  v_receipt public.twilio_message_status_receipts%rowtype;
  v_apply jsonb;
begin
  if tg_table_name = 'booking_notifications' then
    v_message_sid := new.twilio_message_sid;
  elsif tg_table_name = 'staff_action_notification_deliveries' then
    v_message_sid := new.provider_message_id;
  else
    return new;
  end if;

  if v_message_sid is null
     or v_message_sid !~ '^(SM|MM)[0-9A-Fa-f]{32}$'
  then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_message_sid, 1040197)
  );

  select r.*
  into v_receipt
  from public.twilio_message_status_receipts r
  where r.message_sid = v_message_sid
    and r.applied_at is null;

  if found then
    v_apply := public.record_twilio_message_status_receipt(
      v_receipt.message_sid,
      v_receipt.terminal_status,
      v_receipt.error_code
    );
    if v_apply->>'success' <> 'true' then
      raise exception using
        errcode = 'P0001',
        message = 'pending twilio receipt application failed';
    end if;
  end if;

  return new;
end;
$apply_pending$;

drop trigger if exists apply_pending_twilio_receipt_after_notification_insert
  on public.booking_notifications;
create trigger apply_pending_twilio_receipt_after_notification_insert
after insert on public.booking_notifications
for each row
when (new.twilio_message_sid is not null)
execute function public.apply_pending_twilio_receipt_after_correlation();

drop trigger if exists apply_pending_twilio_receipt_after_notification_sid
  on public.booking_notifications;
create trigger apply_pending_twilio_receipt_after_notification_sid
after update of twilio_message_sid on public.booking_notifications
for each row
when (
  new.twilio_message_sid is not null
  and old.twilio_message_sid is distinct from new.twilio_message_sid
)
execute function public.apply_pending_twilio_receipt_after_correlation();

drop trigger if exists apply_pending_twilio_receipt_after_staff_delivery_insert
  on public.staff_action_notification_deliveries;
create trigger apply_pending_twilio_receipt_after_staff_delivery_insert
after insert on public.staff_action_notification_deliveries
for each row
when (new.provider_message_id is not null)
execute function public.apply_pending_twilio_receipt_after_correlation();

drop trigger if exists apply_pending_twilio_receipt_after_staff_delivery_sid
  on public.staff_action_notification_deliveries;
create trigger apply_pending_twilio_receipt_after_staff_delivery_sid
after update of provider_message_id on public.staff_action_notification_deliveries
for each row
when (
  new.provider_message_id is not null
  and old.provider_message_id is distinct from new.provider_message_id
)
execute function public.apply_pending_twilio_receipt_after_correlation();

revoke execute on function public.complete_booking_reminder_delivery(
  uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.complete_booking_reminder_delivery(
  uuid, text, text, text
) to service_role;

revoke execute on function public.record_twilio_message_status_receipt(
  text, text, text
) from public, anon, authenticated;
grant execute on function public.record_twilio_message_status_receipt(
  text, text, text
) to service_role;

revoke execute on function public.apply_pending_twilio_receipt_after_correlation()
  from public, anon, authenticated;
grant execute on function public.apply_pending_twilio_receipt_after_correlation()
  to service_role;
