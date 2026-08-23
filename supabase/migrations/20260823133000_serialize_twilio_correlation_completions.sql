-- Callback-before-completion must use one lock order everywhere: SID advisory
-- lock, then delivery row. Keep the previously audited completion classifiers
-- intact behind service-role-only wrappers and acquire the SID lock first.

alter function public.complete_booking_confirmation_delivery(
  uuid, uuid, text, text, text, text
) rename to complete_booking_confirmation_delivery_unserialized;

revoke all on function public.complete_booking_confirmation_delivery_unserialized(
  uuid, uuid, text, text, text, text
) from public, anon, authenticated, service_role;

create function public.complete_booking_confirmation_delivery(
  p_claim_id uuid,
  p_attempt_token uuid,
  p_status text,
  p_provider_message_id text,
  p_error_code text,
  p_failure_disposition text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $wrapper$
declare
  v_message_sid text := trim(coalesce(p_provider_message_id, ''));
begin
  if not public.staff_action_notification_caller_is_service_role() then
    return jsonb_build_object('success', false, 'code', 'unauthorized');
  end if;

  if p_status = 'sent'
     and v_message_sid ~ '^(SM|MM)[0-9A-Fa-f]{32}$' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_message_sid, 1040197)
    );
  end if;

  return public.complete_booking_confirmation_delivery_unserialized(
    p_claim_id,
    p_attempt_token,
    p_status,
    p_provider_message_id,
    p_error_code,
    p_failure_disposition
  );
end;
$wrapper$;

revoke all on function public.complete_booking_confirmation_delivery(
  uuid, uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.complete_booking_confirmation_delivery(
  uuid, uuid, text, text, text, text
) to service_role;

alter function public.complete_staff_action_notification_delivery(
  uuid, uuid, text, text, text, text
) rename to complete_staff_action_notification_delivery_unserialized;

revoke all on function public.complete_staff_action_notification_delivery_unserialized(
  uuid, uuid, text, text, text, text
) from public, anon, authenticated, service_role;

create function public.complete_staff_action_notification_delivery(
  p_delivery_id uuid,
  p_attempt_token uuid,
  p_status text,
  p_provider_message_id text,
  p_error_code text,
  p_failure_disposition text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $wrapper$
declare
  v_message_sid text := trim(coalesce(p_provider_message_id, ''));
begin
  if not public.staff_action_notification_caller_is_service_role() then
    return jsonb_build_object('success', false, 'code', 'unauthorized');
  end if;

  if p_status = 'sent'
     and v_message_sid ~ '^(SM|MM)[0-9A-Fa-f]{32}$' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_message_sid, 1040197)
    );
  end if;

  return public.complete_staff_action_notification_delivery_unserialized(
    p_delivery_id,
    p_attempt_token,
    p_status,
    p_provider_message_id,
    p_error_code,
    p_failure_disposition
  );
end;
$wrapper$;

revoke all on function public.complete_staff_action_notification_delivery(
  uuid, uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.complete_staff_action_notification_delivery(
  uuid, uuid, text, text, text, text
) to service_role;
