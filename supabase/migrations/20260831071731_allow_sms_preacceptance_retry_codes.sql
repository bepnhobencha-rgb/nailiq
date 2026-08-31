-- Keep the booking-confirmation retry contract aligned with the shared SMS
-- dispatcher. These failures are all proven before the Twilio attempt ledger
-- is claimed, so one bounded retry is safe and preserves the immutable
-- dispatch envelope. Unknown or caller-invented codes remain fail-closed.

create or replace function public.complete_booking_confirmation_delivery_unserialized(
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
as $complete$
declare
  v_claim public.booking_notifications%rowtype;
  v_now timestamptz := transaction_timestamp();
  v_status text := p_status;
  v_error_code text;
  v_disposition text := 'none';
  v_receipt text := nullif(trim(coalesce(p_provider_message_id, '')), '');
  v_completion_fingerprint text;
  v_next_attempt_at timestamptz;
  v_jitter_seconds integer;
  v_transition text;
begin
  if p_claim_id is null or p_attempt_token is null
     or p_status not in ('sent', 'failed', 'suppressed', 'unknown')
     or length(coalesce(p_provider_message_id, '')) > 255
     or length(coalesce(p_error_code, '')) > 80
     or p_failure_disposition not in ('none', 'retryable_pre_acceptance', 'permanent') then
    return jsonb_build_object('success', false, 'code', 'invalid_completion');
  end if;

  select n.* into v_claim from public.booking_notifications n
  where n.id = p_claim_id for update;
  if not found or v_claim.notification_type <> 'booking_confirmation'
     or v_claim.attempt_token is null then
    return jsonb_build_object('success', false, 'code', 'claim_not_found');
  end if;
  if v_claim.attempt_token <> p_attempt_token then
    return jsonb_build_object('success', false, 'code', 'stale_attempt');
  end if;

  v_completion_fingerprint := encode(extensions.digest(pg_catalog.convert_to(
    concat_ws('|', p_status, coalesce(trim(p_provider_message_id), ''),
      coalesce(p_error_code, ''), p_failure_disposition),
    'UTF8'), 'sha256'), 'hex');
  if v_claim.status <> 'sending' then
    if v_claim.completion_fingerprint = v_completion_fingerprint then
      return jsonb_build_object('success', true, 'code', 'already_completed',
        'status', v_claim.status, 'attempt_count', v_claim.attempt_count);
    end if;
    return jsonb_build_object('success', false, 'code', 'completion_conflict',
      'status', v_claim.status, 'attempt_count', v_claim.attempt_count);
  end if;

  if p_status = 'sent' then
    if v_receipt is null
       or (v_claim.channel = 'sms' and v_receipt !~ '^(SM|MM)[0-9A-Fa-f]{32}$')
       or (v_claim.channel = 'email' and (length(v_receipt) > 255 or v_receipt ~ '[[:cntrl:]]')) then
      v_status := 'unknown';
      v_receipt := null;
      v_error_code := 'invalid_provider_receipt';
      v_transition := 'unknown';
    else
      v_error_code := null;
      v_transition := 'sent';
    end if;
  elsif p_status = 'failed' then
    v_receipt := null;
    if (v_claim.channel = 'sms' and p_error_code in (
          'sms_rate_limited_pre_acceptance',
          'sms_unavailable_pre_acceptance',
          'sms_policy_unavailable_pre_acceptance',
          'consent_unavailable_pre_acceptance',
          'sms_delivery_truth_unavailable_pre_acceptance'
        ))
       or (v_claim.channel = 'email' and p_error_code in (
          'email_rate_limited_pre_acceptance', 'email_unavailable_pre_acceptance'
        )) then
      v_error_code := p_error_code;
      if v_claim.attempt_count < 2 and v_claim.expires_at > v_now then
        v_disposition := 'retryable_pre_acceptance';
        v_jitter_seconds := (
          get_byte(extensions.digest(pg_catalog.convert_to(
            v_claim.id::text || ':' || v_claim.attempt_count::text, 'UTF8'
          ), 'sha256'), 0) * 256
          + get_byte(extensions.digest(pg_catalog.convert_to(
            v_claim.id::text || ':' || v_claim.attempt_count::text, 'UTF8'
          ), 'sha256'), 1)
        ) % 61;
        v_next_attempt_at := v_now + interval '5 minutes'
          + make_interval(secs => v_jitter_seconds);
        if v_next_attempt_at >= v_claim.expires_at then
          v_disposition := 'permanent';
          v_next_attempt_at := null;
          v_error_code := 'retry_window_expired';
          v_transition := 'retry_exhausted';
        else
          v_transition := 'retry_scheduled';
        end if;
      else
        v_disposition := 'permanent';
        v_error_code := case when v_claim.attempt_count >= 2
          then 'retry_exhausted' else 'retry_window_expired' end;
        v_transition := 'retry_exhausted';
      end if;
    elsif p_error_code in (
      'invalid_recipient', 'consent_revoked', 'channel_disabled',
      'provider_auth_invalid', 'provider_configuration_invalid',
      'provider_policy_rejected', 'invalid_content', 'unsupported_sender',
      'booking_ineligible', 'material_changed'
    ) then
      v_error_code := p_error_code;
      v_disposition := 'permanent';
      v_transition := 'permanent_failure';
    else
      v_status := 'unknown';
      v_error_code := 'unclassified_provider_outcome';
      v_transition := 'unknown';
    end if;
  elsif p_status = 'suppressed' then
    v_receipt := null;
    v_disposition := 'permanent';
    v_error_code := case when p_error_code in (
      'consent_revoked', 'channel_disabled', 'booking_ineligible', 'recipient_missing'
    ) then p_error_code else 'suppressed_by_policy' end;
    v_transition := 'suppressed';
  else
    v_receipt := null;
    v_error_code := case when p_error_code in (
      'provider_outcome_unknown', 'transport_timeout', 'provider_exception',
      'invalid_provider_receipt', 'completion_write_uncertain'
    ) then p_error_code else 'unclassified_provider_outcome' end;
    v_transition := 'unknown';
  end if;

  update public.booking_notifications set
    status = v_status,
    provider_message_id = v_receipt,
    twilio_message_sid = v_receipt,
    sent_at = case when v_status = 'sent' then v_now else null end,
    failed_at = case when v_status = 'failed' then v_now else null end,
    error_code = v_error_code,
    error_message = v_error_code,
    failure_disposition = v_disposition,
    next_attempt_at = v_next_attempt_at,
    completed_at = v_now,
    updated_at = v_now,
    completion_fingerprint = v_completion_fingerprint,
    reconciliation_reason = case
      when v_error_code = 'retry_exhausted' then 'retry_exhausted'
      when v_error_code = 'retry_window_expired' then 'retry_window_expired'
      else null
    end
  where id = v_claim.id;

  insert into public.booking_notification_delivery_events (
    claim_id, booking_id, salon_id, channel, attempt_count, transition,
    error_code, receipt_present
  ) values (
    v_claim.id, v_claim.booking_id, v_claim.salon_id, v_claim.channel,
    v_claim.attempt_count, v_transition, v_error_code, v_receipt is not null
  ) on conflict do nothing;

  return jsonb_build_object(
    'success', true, 'code', 'completed', 'status', v_status,
    'attempt_count', v_claim.attempt_count,
    'retry_scheduled', v_disposition = 'retryable_pre_acceptance',
    'next_attempt_at', v_next_attempt_at,
    'failure_disposition', v_disposition,
    'caller_disposition_accepted', p_failure_disposition IS NOT DISTINCT FROM v_disposition
  );
end;
$complete$;

revoke all on function public.complete_booking_confirmation_delivery_unserialized(
  uuid, uuid, text, text, text, text
) from public, anon, authenticated, service_role;
