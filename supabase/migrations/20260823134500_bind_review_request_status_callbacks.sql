-- Review-request SMS is initiated from a fire-and-forget product hook. Persist
-- its notification claim before Twilio and include that claim id in the signed
-- StatusCallback URL so response loss cannot leave the receipt unbound.

create function public.complete_review_request_sms_notification(
  p_notification_id uuid,
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
  v_notification public.booking_notifications%rowtype;
  v_message_sid text := nullif(trim(coalesce(p_provider_message_id, '')), '');
  v_error_code text := nullif(trim(coalesce(p_error_code, '')), '');
begin
  if not public.staff_action_notification_caller_is_service_role() then
    return jsonb_build_object('success', false, 'code', 'unauthorized');
  end if;

  if p_notification_id is null
     or p_status not in ('sent', 'failed', 'unknown', 'suppressed')
     or (p_status = 'sent' and (
       v_message_sid is null
       or v_message_sid !~ '^(SM|MM)[0-9A-Fa-f]{32}$'
     ))
     or (p_status <> 'sent' and v_message_sid is not null)
     or (
       v_error_code is not null
       and (length(v_error_code) > 80 or v_error_code ~ '[[:cntrl:]]')
     ) then
    return jsonb_build_object('success', false, 'code', 'invalid_completion');
  end if;

  if v_message_sid is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_message_sid, 1040197)
    );
  end if;

  select n.*
  into v_notification
  from public.booking_notifications n
  where n.id = p_notification_id
  for update;

  if not found
     or v_notification.notification_type <> 'review_request'
     or v_notification.channel <> 'sms' then
    return jsonb_build_object('success', false, 'code', 'claim_not_found');
  end if;

  if v_notification.status <> 'sending' then
    if v_notification.status = p_status
       and v_notification.twilio_message_sid is not distinct from v_message_sid
       and v_notification.error_message is not distinct from v_error_code then
      return jsonb_build_object(
        'success', true,
        'code', 'already_completed',
        'status', v_notification.status
      );
    end if;
    if v_notification.status in ('delivered', 'undelivered', 'failed')
       and v_notification.twilio_message_sid = v_message_sid then
      return jsonb_build_object(
        'success', true,
        'code', 'callback_terminal',
        'status', v_notification.status
      );
    end if;
    return jsonb_build_object(
      'success', false,
      'code', 'completion_conflict',
      'status', v_notification.status
    );
  end if;

  update public.booking_notifications n
  set status = p_status,
      twilio_message_sid = v_message_sid,
      sent_at = case when p_status = 'sent' then transaction_timestamp() else null end,
      failed_at = case when p_status = 'failed' then transaction_timestamp() else null end,
      error_code = v_error_code,
      error_message = v_error_code,
      completed_at = transaction_timestamp(),
      updated_at = transaction_timestamp()
  where n.id = p_notification_id;

  return jsonb_build_object(
    'success', true,
    'code', 'completed',
    'status', p_status
  );
end;
$complete$;

create function public.record_twilio_review_request_status_receipt(
  p_notification_id uuid,
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
begin
  if not public.staff_action_notification_caller_is_service_role() then
    return jsonb_build_object('success', false, 'code', 'unauthorized');
  end if;

  if p_notification_id is null
     or v_message_sid !~ '^(SM|MM)[0-9A-Fa-f]{32}$'
     or v_status not in ('delivered', 'undelivered', 'failed')
     or (v_error_code is not null and v_error_code !~ '^[0-9]{3,8}$')
     or (v_status = 'delivered' and v_error_code is not null) then
    return jsonb_build_object('success', false, 'code', 'invalid_receipt');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_message_sid, 1040197)
  );

  select n.*
  into v_notification
  from public.booking_notifications n
  where n.id = p_notification_id
  for update;

  if not found
     or v_notification.notification_type <> 'review_request'
     or v_notification.channel <> 'sms'
     or v_notification.status not in (
       'sending', 'sent', 'unknown', 'delivered', 'undelivered', 'failed'
     )
     or (
       v_notification.twilio_message_sid is not null
       and v_notification.twilio_message_sid <> v_message_sid
     ) then
    return jsonb_build_object('success', false, 'code', 'invalid_correlation');
  end if;

  if v_notification.twilio_message_sid is null then
    update public.booking_notifications n
    set twilio_message_sid = v_message_sid,
        updated_at = transaction_timestamp()
    where n.id = p_notification_id;
  end if;

  return public.record_twilio_message_status_receipt(
    v_message_sid,
    v_status,
    v_error_code
  );
end;
$record$;

revoke all on function public.complete_review_request_sms_notification(
  uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.complete_review_request_sms_notification(
  uuid, text, text, text
) to service_role;

revoke all on function public.record_twilio_review_request_status_receipt(
  uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.record_twilio_review_request_status_receipt(
  uuid, text, text, text
) to service_role;
