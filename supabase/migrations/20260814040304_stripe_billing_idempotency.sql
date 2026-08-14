-- BILL-006 / BILL-007: serialize subscription Checkout creation per salon and
-- durably claim every verified Stripe event before applying side effects.
--
-- Both ledgers are service-role-only. They contain operational identifiers, a
-- request digest, and allowlisted error codes only: no raw Stripe payloads,
-- request fields, card data, customer fields, or secrets.

create table public.stripe_subscription_checkout_attempts (
  salon_id uuid primary key references public.salons(id) on delete cascade,
  plan text not null check (plan in ('pro', 'premium')),
  generation bigint not null default 1 check (generation > 0),
  state text not null default 'creating'
    check (state in ('creating', 'open', 'reconciling', 'completed', 'closed')),
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  idempotency_key text not null unique,
  checkout_session_id text unique,
  checkout_url text,
  stripe_customer_id text,
  stripe_subscription_id text,
  provider_status text,
  completed_at timestamptz,
  reconciled_at timestamptz,
  claim_count integer not null default 1 check (claim_count > 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  expires_at timestamptz not null,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stripe_subscription_checkout_open_fields_check check (
    state not in ('open', 'reconciling')
    or (checkout_session_id is not null and checkout_url is not null)
  ),
  constraint stripe_subscription_checkout_completed_fields_check check (
    state <> 'completed'
    or (
      checkout_session_id is not null
      and stripe_customer_id is not null
      and stripe_subscription_id is not null
    )
  ),
  constraint stripe_subscription_checkout_error_code_check check (
    last_error_code is null
    or last_error_code in (
      'salon_lookup_failed',
      'customer_persist_failed',
      'customer_create_failed',
      'checkout_url_missing',
      'checkout_expiry_invalid',
      'checkout_create_failed',
      'provider_binding_conflict',
      'provider_reconcile_failed',
      'provider_request_failed'
    )
  ),
  constraint stripe_subscription_checkout_provider_status_check check (
    provider_status is null
    or provider_status in (
      'open',
      'payment_pending',
      'payment_succeeded',
      'payment_failed',
      'checkout_expired',
      'subscription_terminal'
    )
  )
);

create index stripe_subscription_checkout_expiry_idx
  on public.stripe_subscription_checkout_attempts (expires_at)
  where state in ('creating', 'open', 'completed');

alter table public.stripe_subscription_checkout_attempts
  enable row level security;

revoke all on table public.stripe_subscription_checkout_attempts
  from public, anon, authenticated;
grant select, insert, update on table public.stripe_subscription_checkout_attempts
  to service_role;

comment on table public.stripe_subscription_checkout_attempts is
  'One leased subscription Checkout attempt per salon. Provider retries reuse the stored idempotency key.';
comment on column public.stripe_subscription_checkout_attempts.idempotency_key is
  'Stable provider request key for one salon, plan, and generation. Never exposed to salon clients.';
comment on column public.stripe_subscription_checkout_attempts.lease_token is
  'Short-lived fencing token. Only the claimant may publish or release an attempt.';
comment on column public.stripe_subscription_checkout_attempts.provider_status is
  'Allowlisted Stripe Checkout reconciliation state; never a raw provider body.';

-- The folded baseline was missing the two legacy unique Stripe bindings. Never
-- create a unique index by silently discarding a duplicate tenant binding: stop
-- the migration with an operator-safe error so the conflict can be investigated.
do $block$
begin
  if exists (
    select 1
    from public.salons
    where stripe_customer_id is not null
    group by stripe_customer_id
    having count(*) > 1
  ) then
    raise exception 'duplicate Stripe customer bindings block unique index creation'
      using errcode = '23505';
  end if;

  if exists (
    select 1
    from public.salons
    where stripe_subscription_id is not null
    group by stripe_subscription_id
    having count(*) > 1
  ) then
    raise exception 'duplicate Stripe subscription bindings block unique index creation'
      using errcode = '23505';
  end if;
end;
$block$;

create unique index salons_stripe_customer_id_uq
  on public.salons (stripe_customer_id)
  where stripe_customer_id is not null;

create unique index salons_stripe_subscription_id_uq
  on public.salons (stripe_subscription_id)
  where stripe_subscription_id is not null;

create table public.stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  state text not null default 'processing'
    check (state in ('processing', 'processed', 'failed')),
  attempt_count integer not null default 1 check (attempt_count > 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  first_received_at timestamptz not null default now(),
  last_received_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error_code text,
  constraint stripe_webhook_event_id_length_check
    check (length(event_id) between 1 and 255),
  constraint stripe_webhook_event_type_length_check
    check (length(event_type) between 1 and 255),
  constraint stripe_webhook_event_error_code_check check (
    last_error_code is null
    or last_error_code in (
      'handler_failed',
      'checkout_binding_conflict',
      'plan_metadata_invalid',
      'private_offer_terms_invalid',
      'price_mapping_unknown',
      'provider_binding_incomplete',
      'salon_binding_not_found',
      'subscription_status_unsupported'
    )
  )
);

create index stripe_webhook_events_processing_lease_idx
  on public.stripe_webhook_events (lease_expires_at)
  where state = 'processing';

alter table public.stripe_webhook_events enable row level security;

revoke all on table public.stripe_webhook_events
  from public, anon, authenticated;
grant select, insert, update on table public.stripe_webhook_events
  to service_role;

comment on table public.stripe_webhook_events is
  'PII-free Stripe event receipt ledger. The event_id primary key and leases fence replay and concurrent delivery.';
comment on column public.stripe_webhook_events.last_error_code is
  'Allowlisted operational code only; raw provider payloads and errors are never persisted.';

create or replace function public.claim_stripe_subscription_checkout(
  p_salon_id uuid,
  p_plan text,
  p_request_fingerprint text,
  p_now timestamptz
)
returns table (
  outcome text,
  idempotency_key text,
  checkout_url text,
  lease_token uuid,
  reserved_plan text,
  checkout_session_id text,
  expires_at timestamptz,
  requested_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_salon record;
  v_attempt public.stripe_subscription_checkout_attempts%rowtype;
  v_lease_token uuid;
  v_generation bigint;
  v_idempotency_key text;
  v_attempt_found boolean := false;
begin
  if p_plan not in ('pro', 'premium') then
    return query select
      'invalid_plan'::text, null::text, null::text, null::uuid,
      null::text, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  if p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    return query select
      'invalid_request'::text, null::text, null::text, null::uuid,
      null::text, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- The salon row is the authoritative subscription boundary. Lock it only for
  -- this short database transaction; the Stripe network call happens later.
  select
    s.subscription_plan,
    s.subscription_status,
    s.stripe_subscription_id
  into v_salon
  from public.salons s
  where s.id = p_salon_id
  for update;

  if not found then
    return query select
      'missing_salon'::text, null::text, null::text, null::uuid,
      null::text, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- Never open another subscription Checkout while Stripe or the local mirror
  -- already identifies a paid subscription. A free no-card trial has no Stripe
  -- subscription id and remains eligible to start Checkout.
  if nullif(btrim(v_salon.stripe_subscription_id), '') is not null
     or (
       v_salon.subscription_plan in ('pro', 'premium')
       and v_salon.subscription_status in ('active', 'trialing', 'past_due')
     ) then
    return query select
      'active_subscription'::text, null::text, null::text, null::uuid,
      v_salon.subscription_plan::text, null::text, null::timestamptz,
      null::timestamptz;
    return;
  end if;

  select a.*
  into v_attempt
  from public.stripe_subscription_checkout_attempts a
  where a.salon_id = p_salon_id
  for update;
  v_attempt_found := found;

  if v_attempt_found then
    -- A webhook-confirmed subscription remains a durable fence even after the
    -- original Checkout URL expires. Only a terminal subscription state that
    -- has cleared the salon binding can close it and allow a new generation.
    if v_attempt.state = 'completed' then
      if v_salon.subscription_status = 'canceled'
         and nullif(btrim(v_salon.stripe_subscription_id), '') is null then
        update public.stripe_subscription_checkout_attempts
        set state = 'closed',
            provider_status = 'subscription_terminal',
            reconciled_at = p_now,
            updated_at = p_now
        where salon_id = p_salon_id;
        v_attempt.state := 'closed';
      else
        return query select
          'active_subscription'::text, v_attempt.idempotency_key,
          null::text, null::uuid, v_attempt.plan,
          v_attempt.checkout_session_id, v_attempt.expires_at,
          v_attempt.created_at;
        return;
      end if;
    end if;

    -- A provider-confirmed closed attempt is the only existing row that may
    -- rotate plan, request digest, and idempotency generation.
    if v_attempt.state <> 'closed' and v_attempt.plan is distinct from p_plan then
      return query select
        'conflicting_plan'::text, v_attempt.idempotency_key,
        null::text, null::uuid, v_attempt.plan,
        v_attempt.checkout_session_id, v_attempt.expires_at,
        v_attempt.created_at;
      return;
    end if;

    -- Stripe requires retries using one idempotency key to carry identical
    -- parameters. The caller hashes the complete request descriptor so changed
    -- pricing, return URLs, signer data, or offer schedule cannot reuse a key.
    if v_attempt.state <> 'closed'
       and v_attempt.request_fingerprint is distinct from p_request_fingerprint then
      return query select
        'conflicting_request'::text, v_attempt.idempotency_key,
        null::text, null::uuid, v_attempt.plan,
        v_attempt.checkout_session_id, v_attempt.expires_at,
        v_attempt.created_at;
      return;
    end if;

    if v_attempt.state = 'open'
       and v_attempt.checkout_url is not null
       and v_attempt.expires_at > p_now then
      return query select
        'reuse'::text, v_attempt.idempotency_key, v_attempt.checkout_url,
        null::uuid, v_attempt.plan, v_attempt.checkout_session_id,
        v_attempt.expires_at, v_attempt.created_at;
      return;
    end if;

    if v_attempt.state in ('open', 'reconciling')
       and v_attempt.checkout_session_id is not null then
      if v_attempt.state = 'reconciling'
         and v_attempt.lease_token is not null
         and v_attempt.lease_expires_at > p_now then
        return query select
          'pending'::text, v_attempt.idempotency_key, null::text,
          null::uuid, v_attempt.plan, v_attempt.checkout_session_id,
          v_attempt.expires_at, v_attempt.created_at;
        return;
      end if;

      -- The URL timestamp is only local evidence. Before rotating a generation,
      -- lease an explicit provider reconciliation and let Stripe say whether
      -- the Session is still open, complete, or truly expired.
      v_lease_token := gen_random_uuid();
      update public.stripe_subscription_checkout_attempts
      set state = 'reconciling',
          claim_count = claim_count + 1,
          lease_token = v_lease_token,
          lease_expires_at = p_now + interval '90 seconds',
          last_error_code = null,
          updated_at = p_now
      where salon_id = p_salon_id
      returning * into v_attempt;

      return query select
        'reconcile'::text, v_attempt.idempotency_key, null::text,
        v_attempt.lease_token, v_attempt.plan, v_attempt.checkout_session_id,
        v_attempt.expires_at, v_attempt.created_at;
      return;
    end if;

    if v_attempt.state = 'creating'
       and v_attempt.lease_token is not null
       and v_attempt.lease_expires_at > p_now then
      return query select
        'pending'::text, v_attempt.idempotency_key, null::text,
        null::uuid, v_attempt.plan, v_attempt.checkout_session_id,
        v_attempt.expires_at, v_attempt.created_at;
      return;
    end if;

    if v_attempt.state = 'creating' and v_attempt.expires_at <= p_now then
      -- Stripe only guarantees retention of idempotency results for at least
      -- 24 hours. If a process died before recording the Session id, automatic
      -- rotation could create a second subscription. Fail closed for operator
      -- reconciliation instead of guessing.
      return query select
        'pending'::text, v_attempt.idempotency_key, null::text,
        null::uuid, v_attempt.plan, v_attempt.checkout_session_id,
        v_attempt.expires_at, v_attempt.created_at;
      return;
    end if;

    if v_attempt.state = 'creating' then
      -- Retry an interrupted or failed provider request with the SAME Stripe
      -- key while its result is still within the provider retention window.
      v_lease_token := gen_random_uuid();
      update public.stripe_subscription_checkout_attempts
      set claim_count = claim_count + 1,
          lease_token = v_lease_token,
          lease_expires_at = p_now + interval '90 seconds',
          last_error_code = null,
          updated_at = p_now
      where salon_id = p_salon_id
      returning * into v_attempt;

      return query select
        'acquired'::text, v_attempt.idempotency_key, null::text,
        v_attempt.lease_token, v_attempt.plan, v_attempt.checkout_session_id,
        v_attempt.expires_at, v_attempt.created_at;
      return;
    end if;

    if v_attempt.state <> 'closed' then
      return query select
        'pending'::text, v_attempt.idempotency_key, null::text,
        null::uuid, v_attempt.plan, v_attempt.checkout_session_id,
        v_attempt.expires_at, v_attempt.created_at;
      return;
    end if;
  end if;

  v_generation := case when v_attempt_found then v_attempt.generation + 1 else 1 end;
  v_idempotency_key := format(
    'nailiq:subscription-checkout:%s:%s:%s',
    p_salon_id,
    p_plan,
    v_generation
  );
  v_lease_token := gen_random_uuid();

  insert into public.stripe_subscription_checkout_attempts (
    salon_id,
    plan,
    generation,
    state,
    request_fingerprint,
    idempotency_key,
    checkout_session_id,
    checkout_url,
    claim_count,
    lease_token,
    lease_expires_at,
    expires_at,
    last_error_code,
    created_at,
    updated_at
  ) values (
    p_salon_id,
    p_plan,
    v_generation,
    'creating',
    p_request_fingerprint,
    v_idempotency_key,
    null,
    null,
    1,
    v_lease_token,
    p_now + interval '90 seconds',
    p_now + interval '24 hours',
    null,
    p_now,
    p_now
  )
  on conflict (salon_id) do update
  set plan = excluded.plan,
      generation = excluded.generation,
      state = excluded.state,
      request_fingerprint = excluded.request_fingerprint,
      idempotency_key = excluded.idempotency_key,
      checkout_session_id = null,
      checkout_url = null,
      stripe_customer_id = null,
      stripe_subscription_id = null,
      provider_status = null,
      completed_at = null,
      reconciled_at = null,
      claim_count = excluded.claim_count,
      lease_token = excluded.lease_token,
      lease_expires_at = excluded.lease_expires_at,
      expires_at = excluded.expires_at,
      last_error_code = null,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at
  returning * into v_attempt;

  return query select
    'acquired'::text, v_attempt.idempotency_key, null::text,
    v_attempt.lease_token, v_attempt.plan, v_attempt.checkout_session_id,
    v_attempt.expires_at, v_attempt.created_at;
end;
$function$;

create or replace function public.finish_stripe_subscription_checkout(
  p_salon_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_checkout_session_id text,
  p_checkout_url text,
  p_expires_at timestamptz,
  p_error_code text,
  p_now timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if p_outcome not in ('open', 'retryable_failure') then
    raise exception 'invalid Stripe checkout outcome: %', p_outcome
      using errcode = '22023';
  end if;

  if p_outcome = 'open'
     and (
       nullif(btrim(p_checkout_session_id), '') is null
       or nullif(btrim(p_checkout_url), '') is null
       or p_expires_at is null
       or p_expires_at <= p_now
     ) then
    raise exception 'open Stripe checkout requires a live session'
      using errcode = '22023';
  end if;

  update public.stripe_subscription_checkout_attempts
  set state = case when p_outcome = 'open' then 'open' else 'creating' end,
      checkout_session_id = case
        when p_outcome = 'open' then p_checkout_session_id
        else checkout_session_id
      end,
      checkout_url = case
        when p_outcome = 'open' then p_checkout_url
        else checkout_url
      end,
      expires_at = case
        when p_outcome = 'open' then p_expires_at
        else expires_at
      end,
      last_error_code = case
        when p_outcome = 'open' then null
        when p_error_code in (
          'salon_lookup_failed',
          'customer_persist_failed',
          'customer_create_failed',
          'checkout_url_missing',
          'checkout_expiry_invalid',
          'checkout_create_failed'
        ) then p_error_code
        else 'provider_request_failed'
      end,
      lease_token = null,
      lease_expires_at = null,
      updated_at = p_now
  where salon_id = p_salon_id
    and state = 'creating'
    and lease_token = p_lease_token;

  return found;
end;
$function$;

create or replace function public.reconcile_stripe_subscription_checkout(
  p_salon_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_checkout_url text,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_provider_status text,
  p_expires_at timestamptz,
  p_now timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if p_outcome not in ('open', 'completed', 'closed', 'retryable_failure') then
    raise exception 'invalid Stripe reconciliation outcome: %', p_outcome
      using errcode = '22023';
  end if;

  if p_outcome = 'open'
     and (
       nullif(btrim(p_checkout_url), '') is null
       or p_expires_at is null
       or p_expires_at <= p_now
       or p_provider_status is distinct from 'open'
     ) then
    raise exception 'open reconciliation requires a live Stripe Checkout Session'
      using errcode = '22023';
  end if;

  if p_outcome = 'completed'
     and (
       nullif(btrim(p_stripe_customer_id), '') is null
       or nullif(btrim(p_stripe_subscription_id), '') is null
       or p_provider_status not in (
         'payment_pending',
         'payment_succeeded',
         'payment_failed'
       )
     ) then
    raise exception 'completed reconciliation requires provider bindings'
      using errcode = '22023';
  end if;

  if p_outcome = 'closed'
     and p_provider_status is distinct from 'checkout_expired' then
    raise exception 'closed reconciliation requires an expired provider Session'
      using errcode = '22023';
  end if;

  update public.stripe_subscription_checkout_attempts
  set state = case p_outcome
        when 'open' then 'open'
        when 'completed' then 'completed'
        when 'closed' then 'closed'
        else 'open'
      end,
      checkout_url = case
        when p_outcome = 'open' then p_checkout_url
        else checkout_url
      end,
      stripe_customer_id = case
        when p_outcome = 'completed' then p_stripe_customer_id
        else stripe_customer_id
      end,
      stripe_subscription_id = case
        when p_outcome = 'completed' then p_stripe_subscription_id
        else stripe_subscription_id
      end,
      provider_status = case
        when p_outcome = 'retryable_failure' then provider_status
        else p_provider_status
      end,
      expires_at = case
        when p_outcome = 'open' then p_expires_at
        else expires_at
      end,
      completed_at = case
        when p_outcome = 'completed' then coalesce(completed_at, p_now)
        else completed_at
      end,
      reconciled_at = p_now,
      last_error_code = case
        when p_outcome = 'retryable_failure' then 'provider_reconcile_failed'
        else null
      end,
      lease_token = null,
      lease_expires_at = null,
      updated_at = p_now
  where salon_id = p_salon_id
    and state = 'reconciling'
    and lease_token = p_lease_token;

  return found;
end;
$function$;

create or replace function public.mark_stripe_subscription_checkout_completed(
  p_salon_id uuid,
  p_checkout_session_id text,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_provider_status text,
  p_now timestamptz
)
returns text
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_attempt public.stripe_subscription_checkout_attempts%rowtype;
begin
  if nullif(btrim(p_checkout_session_id), '') is null
     or nullif(btrim(p_stripe_customer_id), '') is null
     or nullif(btrim(p_stripe_subscription_id), '') is null
     or p_provider_status not in (
       'payment_pending',
       'payment_succeeded',
       'payment_failed'
     ) then
    return 'invalid';
  end if;

  select a.*
  into v_attempt
  from public.stripe_subscription_checkout_attempts a
  where a.salon_id = p_salon_id
    and (
      a.checkout_session_id = p_checkout_session_id
      or (
        a.state = 'creating'
        and a.checkout_session_id is null
      )
    )
  for update;

  if not found then
    return 'missing';
  end if;

  if v_attempt.state = 'closed'
     or (
       v_attempt.stripe_customer_id is not null
       and v_attempt.stripe_customer_id is distinct from p_stripe_customer_id
     )
     or (
       v_attempt.stripe_subscription_id is not null
       and v_attempt.stripe_subscription_id is distinct from p_stripe_subscription_id
     ) then
    return 'conflict';
  end if;

  update public.stripe_subscription_checkout_attempts
  set state = 'completed',
      checkout_session_id = p_checkout_session_id,
      stripe_customer_id = p_stripe_customer_id,
      stripe_subscription_id = p_stripe_subscription_id,
      provider_status = case
        -- Provider events may be delivered out of order. Success is terminal
        -- for this Checkout attempt and must never be downgraded by a late
        -- completed/failed delivery; failed must not be softened to pending.
        when provider_status = 'payment_succeeded' then provider_status
        when p_provider_status = 'payment_succeeded' then p_provider_status
        when provider_status = 'payment_failed'
             and p_provider_status = 'payment_pending' then provider_status
        else p_provider_status
      end,
      completed_at = coalesce(completed_at, p_now),
      reconciled_at = p_now,
      lease_token = null,
      lease_expires_at = null,
      last_error_code = null,
      updated_at = p_now
  where salon_id = p_salon_id;

  return case when v_attempt.state = 'completed' then 'duplicate' else 'marked' end;
end;
$function$;

create or replace function public.close_stripe_subscription_checkout(
  p_salon_id uuid,
  p_stripe_subscription_id text,
  p_provider_status text,
  p_now timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if nullif(btrim(p_stripe_subscription_id), '') is null
     or p_provider_status is distinct from 'subscription_terminal' then
    return false;
  end if;

  update public.stripe_subscription_checkout_attempts
  set state = 'closed',
      provider_status = 'subscription_terminal',
      reconciled_at = p_now,
      lease_token = null,
      lease_expires_at = null,
      last_error_code = null,
      updated_at = p_now
  where salon_id = p_salon_id
    and stripe_subscription_id = p_stripe_subscription_id;

  return found;
end;
$function$;

create or replace function public.claim_stripe_webhook_event(
  p_event_id text,
  p_event_type text,
  p_now timestamptz
)
returns table (
  outcome text,
  lease_token uuid,
  attempt_count integer
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_event public.stripe_webhook_events%rowtype;
  v_lease_token uuid := gen_random_uuid();
begin
  if nullif(btrim(p_event_id), '') is null
     or length(p_event_id) > 255
     or nullif(btrim(p_event_type), '') is null
     or length(p_event_type) > 255 then
    return query select 'invalid'::text, null::uuid, 0::integer;
    return;
  end if;

  insert into public.stripe_webhook_events (
    event_id,
    event_type,
    state,
    attempt_count,
    lease_token,
    lease_expires_at,
    first_received_at,
    last_received_at
  ) values (
    p_event_id,
    p_event_type,
    'processing',
    1,
    v_lease_token,
    p_now + interval '5 minutes',
    p_now,
    p_now
  )
  on conflict (event_id) do nothing
  returning * into v_event;

  if found then
    return query select 'acquired'::text, v_event.lease_token, v_event.attempt_count;
    return;
  end if;

  select e.*
  into v_event
  from public.stripe_webhook_events e
  where e.event_id = p_event_id
  for update;

  if not found or v_event.event_type is distinct from p_event_type then
    return query select 'conflict'::text, null::uuid, 0::integer;
    return;
  end if;

  if v_event.state = 'processed' then
    update public.stripe_webhook_events
    set last_received_at = p_now
    where event_id = p_event_id;
    return query select 'duplicate'::text, null::uuid, v_event.attempt_count;
    return;
  end if;

  if v_event.state = 'processing'
     and v_event.lease_token is not null
     and v_event.lease_expires_at > p_now then
    update public.stripe_webhook_events
    set last_received_at = p_now
    where event_id = p_event_id;
    return query select 'in_progress'::text, null::uuid, v_event.attempt_count;
    return;
  end if;

  v_lease_token := gen_random_uuid();
  update public.stripe_webhook_events as claimed_event
  set state = 'processing',
      attempt_count = claimed_event.attempt_count + 1,
      lease_token = v_lease_token,
      lease_expires_at = p_now + interval '5 minutes',
      last_received_at = p_now,
      processed_at = null,
      last_error_code = null
  where claimed_event.event_id = p_event_id
  returning * into v_event;

  return query select 'acquired'::text, v_event.lease_token, v_event.attempt_count;
end;
$function$;

create or replace function public.finish_stripe_webhook_event(
  p_event_id text,
  p_lease_token uuid,
  p_outcome text,
  p_error_code text,
  p_now timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if p_outcome not in ('processed', 'failed') then
    raise exception 'invalid Stripe webhook outcome: %', p_outcome
      using errcode = '22023';
  end if;

  update public.stripe_webhook_events
  set state = p_outcome,
      lease_token = null,
      lease_expires_at = null,
      processed_at = case when p_outcome = 'processed' then p_now else null end,
      last_error_code = case
        when p_outcome = 'processed' then null
        when p_error_code in (
          'checkout_binding_conflict',
          'plan_metadata_invalid',
          'private_offer_terms_invalid',
          'price_mapping_unknown',
          'provider_binding_incomplete',
          'salon_binding_not_found',
          'subscription_status_unsupported'
        ) then p_error_code
        else 'handler_failed'
      end,
      last_received_at = p_now
  where event_id = p_event_id
    and state = 'processing'
    and lease_token = p_lease_token;

  return found;
end;
$function$;

revoke all on function public.claim_stripe_subscription_checkout(uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_stripe_subscription_checkout(uuid, text, text, timestamptz)
  to service_role;

revoke all on function public.finish_stripe_subscription_checkout(
  uuid, uuid, text, text, text, timestamptz, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.finish_stripe_subscription_checkout(
  uuid, uuid, text, text, text, timestamptz, text, timestamptz
) to service_role;

revoke all on function public.reconcile_stripe_subscription_checkout(
  uuid, uuid, text, text, text, text, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.reconcile_stripe_subscription_checkout(
  uuid, uuid, text, text, text, text, text, timestamptz, timestamptz
) to service_role;

revoke all on function public.mark_stripe_subscription_checkout_completed(
  uuid, text, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.mark_stripe_subscription_checkout_completed(
  uuid, text, text, text, text, timestamptz
) to service_role;

revoke all on function public.close_stripe_subscription_checkout(
  uuid, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.close_stripe_subscription_checkout(
  uuid, text, text, timestamptz
) to service_role;

revoke all on function public.claim_stripe_webhook_event(text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_stripe_webhook_event(text, text, timestamptz)
  to service_role;

revoke all on function public.finish_stripe_webhook_event(text, uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.finish_stripe_webhook_event(text, uuid, text, text, timestamptz)
  to service_role;
