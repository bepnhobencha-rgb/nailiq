-- Turn recent structural strategist recommendations into a single, durable
-- owner decision without ever applying the recommendation automatically.

alter table public.approval_requests
  add column source_action_id uuid
    references public.ai_actions_log(id);

create unique index approval_requests_source_action_once_idx
  on public.approval_requests (source_action_id)
  where source_action_id is not null;

comment on column public.approval_requests.source_action_id is
  'Optional AI activity source. Uniqueness prevents the same recommendation from being proposed repeatedly across manager retries.';

create or replace function public.surface_strategist_operational_note_approval(
  p_salon_id uuid,
  p_now timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_source public.ai_actions_log%rowtype;
  v_existing_id uuid;
  v_created_id uuid;
  v_title text;
  v_reasoning text;
  v_note text;
begin
  if p_salon_id is null or p_now is null then
    raise exception 'salon and current time are required' using errcode = '22023';
  end if;

  select *
    into v_source
    from public.ai_actions_log
   where salon_id = p_salon_id
     and agent = 'strategist'
     and action_type = 'escalate_structural'
     and created_at >= p_now - interval '14 days'
     and created_at <= p_now
   order by created_at desc, id desc
   limit 1;

  if not found then
    return jsonb_build_object('status', 'no_candidate');
  end if;

  select id
    into v_existing_id
    from public.approval_requests
   where source_action_id = v_source.id
   limit 1;
  if found then
    return jsonb_build_object(
      'status', 'existing',
      'approval_request_id', v_existing_id,
      'source_action_id', v_source.id
    );
  end if;

  v_title := nullif(btrim(v_source.payload->>'title'), '');
  v_reasoning := nullif(btrim(v_source.payload->>'reasoning'), '');
  v_note := left(
    concat_ws(
      E'\n\n',
      coalesce(v_title, 'Strategist operational recommendation'),
      v_reasoning
    ),
    1000
  );

  insert into public.approval_requests (
    salon_id,
    action_type,
    summary,
    payload,
    urgency,
    status,
    expires_at,
    source_action_id
  ) values (
    p_salon_id,
    'record_operational_note',
    left(
      'Review and record: ' ||
        coalesce(v_title, 'strategist operational recommendation'),
      500
    ),
    jsonb_build_object(
      'proposal_source', 'weekly_strategist',
      'proposal_type', 'structural',
      'source_action_id', v_source.id,
      'note', v_note,
      'reason', left(
        coalesce(
          v_reasoning,
          'Structural recommendation from the weekly strategist.'
        ),
        2000
      ),
      'evidence', jsonb_build_array(
        left(
          coalesce(
            nullif(btrim(v_source.payload->>'strategist_summary'), ''),
            'The weekly strategist identified this structural operating recommendation.'
          ),
          1000
        )
      ),
      'expected_impact',
        'Preserve the recommendation in the salon operating record for owner follow-up.',
      'confidence', 0.7,
      'reversible', true
    ),
    'normal',
    'pending',
    p_now + interval '7 days',
    v_source.id
  )
  on conflict (source_action_id)
    where source_action_id is not null
    do nothing
  returning id into v_created_id;

  if v_created_id is not null then
    return jsonb_build_object(
      'status', 'created',
      'approval_request_id', v_created_id,
      'source_action_id', v_source.id
    );
  end if;

  select id
    into v_existing_id
    from public.approval_requests
   where source_action_id = v_source.id
   limit 1;

  return jsonb_build_object(
    'status', 'existing',
    'approval_request_id', v_existing_id,
    'source_action_id', v_source.id
  );
end;
$$;

revoke all on function public.surface_strategist_operational_note_approval(
  uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.surface_strategist_operational_note_approval(
  uuid, timestamptz
) to service_role;
