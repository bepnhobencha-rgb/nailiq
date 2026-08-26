-- MQA-0175: turn the customer-history upsell "shown" write into one atomic,
-- replayable claim. The claim is internal/service-role-only and contains no raw
-- phone, email, customer name, or bearer OTP capability.

create table public.ai_upsell_session_claims (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  session_id uuid not null,
  phone_fingerprint text not null
    check (phone_fingerprint ~ '^[0-9a-f]{64}$'),
  capability_fingerprint text not null
    check (capability_fingerprint ~ '^[0-9a-f]{64}$'),
  selected_service_id uuid not null,
  suggested_service_id uuid not null,
  offer_material_fingerprint text not null
    check (offer_material_fingerprint ~ '^[0-9a-f]{64}$'),
  offer_payload jsonb not null
    check (
      jsonb_typeof(offer_payload) = 'object'
      and offer_payload ?& array[
        'available', 'service_id', 'service_name', 'price_cents',
        'price_type', 'price_max_cents', 'added_duration_minutes',
        'reason', 'confidence', 'session_id'
      ]
      and offer_payload - array[
        'available', 'service_id', 'service_name', 'price_cents',
        'price_type', 'price_max_cents', 'added_duration_minutes',
        'reason', 'confidence', 'session_id'
      ] = '{}'::jsonb
      and offer_payload->'available' = 'true'::jsonb
      and offer_payload->>'service_id' = suggested_service_id::text
      and offer_payload->>'session_id' = session_id::text
      and jsonb_typeof(offer_payload->'service_name') = 'string'
      and char_length(offer_payload->>'service_name') between 1 and 255
      and (offer_payload->>'service_name') !~ '[[:cntrl:]]'
      and jsonb_typeof(offer_payload->'price_cents') = 'number'
      and (offer_payload->>'price_cents')::numeric >= 0
      and (offer_payload->>'price_cents')::numeric
          = trunc((offer_payload->>'price_cents')::numeric)
      and offer_payload->>'price_type' in ('fixed', 'from', 'range')
      and (
        offer_payload->'price_max_cents' = 'null'::jsonb
        or (
          jsonb_typeof(offer_payload->'price_max_cents') = 'number'
          and (offer_payload->>'price_max_cents')::numeric >= 0
          and (offer_payload->>'price_max_cents')::numeric
              = trunc((offer_payload->>'price_max_cents')::numeric)
        )
      )
      and jsonb_typeof(offer_payload->'added_duration_minutes') = 'number'
      and (offer_payload->>'added_duration_minutes')::numeric >= 0
      and (offer_payload->>'added_duration_minutes')::numeric
          = trunc((offer_payload->>'added_duration_minutes')::numeric)
      and jsonb_typeof(offer_payload->'reason') = 'string'
      and char_length(offer_payload->>'reason') between 1 and 500
      and (offer_payload->>'reason') !~ '[[:cntrl:]]'
      and jsonb_typeof(offer_payload->'confidence') = 'number'
      and (offer_payload->>'confidence')::numeric between 0 and 1
    ),
  upsell_log_id uuid not null unique,
  created_at timestamptz not null default now(),
  constraint ai_upsell_session_claims_salon_session_unique
    unique (salon_id, session_id),
  constraint ai_upsell_session_claims_distinct_services
    check (selected_service_id <> suggested_service_id),
  constraint ai_upsell_session_claims_log_fkey
    foreign key (upsell_log_id) references public.ai_upsell_log(id)
    on delete cascade deferrable initially deferred
);

comment on table public.ai_upsell_session_claims is
  'Immutable service-role-only one-offer-per-session claims. Stores fingerprints and bounded non-PII offer payloads; no raw customer identity or OTP capability.';

create index ai_upsell_session_claims_salon_created_idx
  on public.ai_upsell_session_claims (salon_id, created_at desc);
create index ai_upsell_session_claims_selected_service_idx
  on public.ai_upsell_session_claims (selected_service_id);
create index ai_upsell_session_claims_suggested_service_idx
  on public.ai_upsell_session_claims (suggested_service_id);

alter table public.ai_upsell_session_claims enable row level security;
alter table public.ai_upsell_session_claims force row level security;

revoke all on table public.ai_upsell_session_claims
  from public, anon, authenticated, service_role;
grant select, insert on table public.ai_upsell_session_claims to service_role;

create policy "service role claims one upsell per salon session"
  on public.ai_upsell_session_claims
  for all to service_role
  using (true)
  with check (true);

-- The public app has no direct ai_upsell_log client. Keep salon-member read
-- access for reporting, but force every shown/outcome mutation through the
-- capability-bound service routes.
drop policy if exists "Salon members update upsell log"
  on public.ai_upsell_log;
drop policy if exists "Salon members write upsell log"
  on public.ai_upsell_log;
revoke insert, update, delete, truncate, references, trigger
  on table public.ai_upsell_log from anon, authenticated;

create or replace function public.reject_ai_upsell_session_claim_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Preserve intentional salon/service cleanup through an FK cascade. Direct
  -- mutation remains forbidden even to a service-role caller.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'ai_upsell_session_claim_is_immutable'
    using errcode = '55000';
end;
$$;

create trigger ai_upsell_session_claims_immutable
  before update or delete on public.ai_upsell_session_claims
  for each row execute function public.reject_ai_upsell_session_claim_mutation();

revoke all on function public.reject_ai_upsell_session_claim_mutation()
  from public, anon, authenticated;

create or replace function public.claim_ai_upsell_offer(
  p_salon_id uuid,
  p_session_id uuid,
  p_otp_session_id uuid,
  p_client_phone text,
  p_selected_service_id uuid,
  p_suggested_service_id uuid,
  p_suggestion_reason text,
  p_confidence_score numeric
)
returns table (
  outcome text,
  claim_id uuid,
  upsell_log_id uuid,
  replay boolean,
  offer_payload jsonb
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_phone text := regexp_replace(coalesce(p_client_phone, ''), '\D', '', 'g');
  v_phone_fingerprint text;
  v_capability_fingerprint text;
  v_offer_material jsonb;
  v_offer_material_fingerprint text;
  v_offer_payload jsonb;
  v_offer_service public.services%rowtype;
  v_claim_id uuid := gen_random_uuid();
  v_log_id uuid := gen_random_uuid();
  v_inserted_id uuid;
  v_existing public.ai_upsell_session_claims%rowtype;
  v_capability_valid boolean;
  v_frequency_percent integer;
  v_reason_en text;
  v_reason_vi text;
begin
  if p_salon_id is null
     or p_session_id is null
     or p_otp_session_id is null
     or p_selected_service_id is null
     or p_suggested_service_id is null
     or p_selected_service_id = p_suggested_service_id
     or v_phone !~ '^[0-9]{10,15}$'
     or p_suggestion_reason is null
     or char_length(p_suggestion_reason) not between 1 and 500
     or p_suggestion_reason ~ '[[:cntrl:]]'
     or p_confidence_score is null
     or p_confidence_score < 0
     or p_confidence_score > 1 then
    return query select 'invalid_request'::text, null::uuid, null::uuid,
                        false, null::jsonb;
    return;
  end if;

  v_frequency_percent := round(p_confidence_score * 100);
  v_reason_en := 'You usually add this (' || v_frequency_percent
                 || '% of your visits)';
  v_reason_vi := 'Bạn thường thêm dịch vụ này (' || v_frequency_percent
                 || '% lần ghé thăm)';
  if p_suggestion_reason <> v_reason_en
     and p_suggestion_reason <> v_reason_vi then
    return query select 'invalid_request'::text, null::uuid, null::uuid,
                        false, null::jsonb;
    return;
  end if;

  select public.validate_phone_otp_session(
    p_otp_session_id, p_salon_id, v_phone
  ) into v_capability_valid;
  if v_capability_valid is distinct from true then
    return query select 'invalid_capability'::text, null::uuid, null::uuid,
                        false, null::jsonb;
    return;
  end if;

  v_phone_fingerprint := encode(extensions.digest(
    pg_catalog.convert_to(p_salon_id::text || E'\n' || v_phone, 'UTF8'),
    'sha256'
  ), 'hex');
  v_capability_fingerprint := encode(extensions.digest(
    pg_catalog.convert_to(
      p_salon_id::text || E'\n' || p_otp_session_id::text || E'\n'
      || v_phone_fingerprint,
      'UTF8'
    ),
    'sha256'
  ), 'hex');

  -- A committed claim is the durable receipt. Exact retries return its stored
  -- payload even if the menu row is later edited or soft-deleted; a retry may
  -- not substitute another capability, service, localized reason or score.
  select * into v_existing
    from public.ai_upsell_session_claims existing
   where existing.salon_id = p_salon_id
     and existing.session_id = p_session_id;
  if found then
    if v_existing.phone_fingerprint <> v_phone_fingerprint
       or v_existing.capability_fingerprint <> v_capability_fingerprint then
      return query select 'capability_mismatch'::text, null::uuid, null::uuid,
                          false, null::jsonb;
    elsif v_existing.selected_service_id <> p_selected_service_id
       or v_existing.suggested_service_id <> p_suggested_service_id
       or v_existing.offer_payload->>'reason' <> p_suggestion_reason
       or (v_existing.offer_payload->>'confidence')::numeric
          <> p_confidence_score then
      return query select 'offer_material_mismatch'::text, null::uuid,
                          null::uuid, false, null::jsonb;
    else
      return query select 'replayed'::text, v_existing.id,
                          v_existing.upsell_log_id, true,
                          v_existing.offer_payload;
    end if;
    return;
  end if;

  -- Both selected and suggested services must still be active material from
  -- the exact tenant when the atomic claim is acquired.
  if not exists (
    select 1 from public.services selected
     where selected.id = p_selected_service_id
       and selected.salon_id = p_salon_id
       and selected.deleted_at is null
       and selected.is_addon is not true
  ) then
    return query select 'selected_service_invalid'::text, null::uuid,
                        null::uuid, false, null::jsonb;
    return;
  end if;

  select * into v_offer_service
    from public.services offered
   where offered.id = p_suggested_service_id
     and offered.salon_id = p_salon_id
     and offered.deleted_at is null
     and offered.is_addon is true
     and char_length(btrim(offered.name)) between 1 and 255
     and offered.name !~ '[[:cntrl:]]'
     and offered.price_cents >= 0
     and (offered.price_max_cents is null or offered.price_max_cents >= 0);
  if not found then
    return query select 'suggested_service_invalid'::text, null::uuid,
                        null::uuid, false, null::jsonb;
    return;
  end if;

  v_offer_payload := jsonb_build_object(
    'available', true,
    'service_id', v_offer_service.id,
    'service_name', v_offer_service.name,
    'price_cents', v_offer_service.price_cents,
    'price_type', v_offer_service.price_type,
    'price_max_cents', v_offer_service.price_max_cents,
    'added_duration_minutes', case
      when v_offer_service.addon_timing = 'concurrent' then 0
      else greatest(0, v_offer_service.duration_minutes)
           + greatest(0, v_offer_service.buffer_minutes)
    end,
    'reason', p_suggestion_reason,
    'confidence', p_confidence_score,
    'session_id', p_session_id
  );
  v_offer_material := jsonb_build_object(
    'salon_id', p_salon_id,
    'session_id', p_session_id,
    'capability_fingerprint', v_capability_fingerprint,
    'selected_service_id', p_selected_service_id,
    'suggested_service_id', p_suggested_service_id,
    'offer_payload', v_offer_payload
  );
  v_offer_material_fingerprint := encode(extensions.digest(
    pg_catalog.convert_to(v_offer_material::text, 'UTF8'), 'sha256'
  ), 'hex');

  -- The deferred log FK lets the unique salon/session claim win first. The winning
  -- transaction then writes exactly one legacy shown row before commit; a
  -- failed log write rolls the claim back with it.
  insert into public.ai_upsell_session_claims (
    id, salon_id, session_id, phone_fingerprint,
    capability_fingerprint, selected_service_id, suggested_service_id,
    offer_material_fingerprint, offer_payload, upsell_log_id
  ) values (
    v_claim_id, p_salon_id, p_session_id, v_phone_fingerprint,
    v_capability_fingerprint, p_selected_service_id, p_suggested_service_id,
    v_offer_material_fingerprint, v_offer_payload, v_log_id
  )
  on conflict (salon_id, session_id) do nothing
  returning id into v_inserted_id;

  if v_inserted_id is not null then
    -- Compatibility-only PII write: the pre-existing outcome route still
    -- binds ai_upsell_log rows by the verified canonical phone. The immutable
    -- claim table and replay payload above contain fingerprints only. Removing
    -- this legacy field requires a separately reviewed outcome-route migration.
    insert into public.ai_upsell_log (
      id, salon_id, client_phone, session_id, suggested_service_id,
      suggestion_position, suggestion_reason, confidence_score, outcome
    ) values (
      v_log_id, p_salon_id, v_phone, p_session_id::text,
      p_suggested_service_id, 'after_service_select', p_suggestion_reason,
      p_confidence_score, 'shown'
    );
    return query select 'claimed'::text, v_claim_id, v_log_id, false,
                        v_offer_payload;
    return;
  end if;

  select * into v_existing
    from public.ai_upsell_session_claims existing
   where existing.salon_id = p_salon_id
     and existing.session_id = p_session_id;
  if not found then
    return query select 'claim_unavailable'::text, null::uuid, null::uuid,
                        false, null::jsonb;
  elsif v_existing.phone_fingerprint <> v_phone_fingerprint
     or v_existing.capability_fingerprint <> v_capability_fingerprint then
    return query select 'capability_mismatch'::text, null::uuid, null::uuid,
                        false, null::jsonb;
  elsif v_existing.selected_service_id <> p_selected_service_id
     or v_existing.suggested_service_id <> p_suggested_service_id
     or v_existing.offer_material_fingerprint <> v_offer_material_fingerprint
     or v_existing.offer_payload <> v_offer_payload then
    return query select 'offer_material_mismatch'::text, null::uuid,
                        null::uuid, false, null::jsonb;
  else
    return query select 'replayed'::text, v_existing.id,
                        v_existing.upsell_log_id, true,
                        v_existing.offer_payload;
  end if;
end;
$$;

revoke all on function public.claim_ai_upsell_offer(
  uuid, uuid, uuid, text, uuid, uuid, text, numeric
) from public, anon, authenticated;
grant execute on function public.claim_ai_upsell_offer(
  uuid, uuid, uuid, text, uuid, uuid, text, numeric
) to service_role;

comment on function public.claim_ai_upsell_offer(
  uuid, uuid, uuid, text, uuid, uuid, text, numeric
) is
  'Atomically records one capability-bound shown upsell per salon/session and returns the same bounded offer on exact replay; no provider or booking mutation occurs.';
