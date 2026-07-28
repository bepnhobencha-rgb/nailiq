-- A dispatch preflight is point-in-time evidence, not permanent permission.
-- Give each record a short validity window and allow the same unchanged
-- decisions to be revalidated after that window expires.

alter table public.ai_campaign_dispatch_preflights
  add column valid_until timestamptz not null
    default (statement_timestamp() + interval '5 minutes'),
  add constraint ai_campaign_dispatch_preflights_valid_window
    check (valid_until > created_at);

alter table public.ai_campaign_dispatch_preflights
  drop constraint ai_campaign_dispatch_preflights_manifest_id_preflight_fingerprint_key;

create index ai_campaign_dispatch_preflights_manifest_freshness_idx
  on public.ai_campaign_dispatch_preflights (
    manifest_id,
    preflight_fingerprint,
    created_at desc
  );

create or replace function public.record_ai_campaign_dispatch_preflight_fresh(
  p_job_id uuid,
  p_salon_id uuid,
  p_summary jsonb,
  p_decisions jsonb
)
returns table (
  outcome text,
  preflight_id uuid,
  preflight_status text,
  preflight_fingerprint text,
  valid_until timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_outcome text;
  v_returned_preflight_id uuid;
  v_returned_status text;
  v_returned_fingerprint text;
  v_preflight public.ai_campaign_dispatch_preflights%rowtype;
  v_display_summary jsonb;
begin
  select
    r.outcome,
    r.preflight_id,
    r.preflight_status,
    r.preflight_fingerprint
    into
      v_outcome,
      v_returned_preflight_id,
      v_returned_status,
      v_returned_fingerprint
    from public.record_ai_campaign_dispatch_preflight(
      p_job_id,
      p_salon_id,
      p_summary,
      p_decisions,
      v_now
    ) r;

  if v_outcome not in ('created', 'unchanged')
     or v_returned_preflight_id is null then
    return query
      select v_outcome, v_returned_preflight_id, v_returned_status,
             v_returned_fingerprint, null::timestamptz;
    return;
  end if;

  -- The legacy recorder holds the execution-job row lock until this outer
  -- statement ends. Selecting the newest matching evidence therefore makes
  -- concurrent refreshes idempotent without a uniqueness constraint that
  -- would prevent a later, legitimate revalidation.
  select candidate.*
    into v_preflight
    from public.ai_campaign_dispatch_preflights returned
    join public.ai_campaign_dispatch_preflights candidate
      on candidate.manifest_id = returned.manifest_id
     and candidate.preflight_fingerprint =
         returned.preflight_fingerprint
   where returned.id = v_returned_preflight_id
   order by candidate.created_at desc, candidate.id desc
   limit 1;

  if not found then
    raise exception 'campaign_preflight_evidence_missing'
      using errcode = '40001';
  end if;

  if v_preflight.valid_until <= v_now then
    insert into public.ai_campaign_dispatch_preflights (
      salon_id,
      manifest_id,
      release_execution_job_id,
      preflight_fingerprint,
      status,
      summary,
      created_at,
      valid_until
    ) values (
      v_preflight.salon_id,
      v_preflight.manifest_id,
      v_preflight.release_execution_job_id,
      v_preflight.preflight_fingerprint,
      v_preflight.status,
      p_summary || jsonb_build_object(
        'preflight_at', v_now,
        'preflight_status', v_preflight.status,
        'within_recipient_cap',
          (p_summary ->> 'manifest_recipient_count')::integer <= 500,
        'within_cost_cap',
          (p_summary ->> 'estimated_cost_usd_cents')::numeric <= 500,
        'dispatch_enabled', false,
        'no_messages_sent', true,
        'freshness_minutes', 5,
        'valid_until', v_now + interval '5 minutes'
      ),
      v_now,
      v_now + interval '5 minutes'
    )
    returning * into v_preflight;

    v_outcome := 'refreshed';

    insert into public.ai_actions_log (
      salon_id,
      agent,
      action_type,
      target_id,
      payload,
      created_at
    ) values (
      v_preflight.salon_id,
      'execution_worker',
      'campaign_dispatch_preflight_refreshed',
      v_preflight.release_execution_job_id,
      jsonb_build_object(
        'preflight_id', v_preflight.id,
        'manifest_id', v_preflight.manifest_id,
        'preflight_status', v_preflight.status,
        'preflight_fingerprint', v_preflight.preflight_fingerprint,
        'valid_until', v_preflight.valid_until,
        'dispatch_enabled', false,
        'no_messages_sent', true
      ),
      v_now
    );
  end if;

  v_display_summary := v_preflight.summary || jsonb_build_object(
    'preflight_at', v_preflight.created_at,
    'preflight_status', v_preflight.status,
    'freshness_minutes', 5,
    'valid_until', v_preflight.valid_until,
    'dispatch_enabled', false,
    'no_messages_sent', true
  );

  update public.ai_execution_jobs
     set result = jsonb_set(
           coalesce(result, '{}'::jsonb),
           '{dispatch_preflight}',
           v_display_summary,
           true
         ) || jsonb_build_object(
           'blocker', 'dispatch_not_enabled',
           'dispatch_preflight_id', v_preflight.id,
           'dispatch_enabled', false,
           'no_messages_sent', true
         ),
         updated_at = v_now
   where id = p_job_id
     and salon_id = p_salon_id
     and status = 'waiting_input'
     and coalesce(result ->> 'blocker', '') = 'dispatch_not_enabled';

  if not found then
    raise exception 'campaign_preflight_state_changed'
      using errcode = '40001';
  end if;

  return query
    select v_outcome, v_preflight.id, v_preflight.status,
           v_preflight.preflight_fingerprint, v_preflight.valid_until;
end;
$$;

revoke all on function public.record_ai_campaign_dispatch_preflight_fresh(
  uuid, uuid, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.record_ai_campaign_dispatch_preflight_fresh(
  uuid, uuid, jsonb, jsonb
) to service_role;

comment on column public.ai_campaign_dispatch_preflights.valid_until is
  'Exclusive upper bound for treating this point-in-time safety evidence as fresh.';
comment on function public.record_ai_campaign_dispatch_preflight_fresh(
  uuid, uuid, jsonb, jsonb
) is
  'Records or refreshes a five-minute dispatch preflight while live dispatch remains disabled.';
