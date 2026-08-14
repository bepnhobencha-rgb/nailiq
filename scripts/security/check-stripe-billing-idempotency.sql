\set ON_ERROR_STOP on

-- Provider-free database rehearsal for the subscription Checkout and webhook
-- ledgers. It proves replay fencing, monotonic async-payment truth, durable
-- completion past URL expiry, and terminal-only generation rotation.
begin;

insert into public.salons (id, slug, name, phone)
values
  ('91000000-0000-4000-8000-000000000001', 'stripe-ledger-one', 'Stripe Ledger One', '+15550000001'),
  ('91000000-0000-4000-8000-000000000002', 'stripe-ledger-two', 'Stripe Ledger Two', '+15550000002');

do $test$
declare
  v_first record;
  v_next record;
  v_reconcile record;
  v_event record;
  v_ok boolean;
  v_mark text;
  v_status text;
  v_generation bigint;
  v_now timestamptz := '2026-08-14 04:00:00+00';
begin
  if not exists (
    select 1
    from pg_catalog.pg_index i
    join pg_catalog.pg_class c on c.oid = i.indexrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'salons_stripe_customer_id_uq'
      and i.indisunique
      and i.indpred is not null
  ) then
    raise exception 'missing partial unique Stripe customer binding index';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_index i
    join pg_catalog.pg_class c on c.oid = i.indexrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'salons_stripe_subscription_id_uq'
      and i.indisunique
      and i.indpred is not null
  ) then
    raise exception 'missing partial unique Stripe subscription binding index';
  end if;

  update public.salons
  set stripe_customer_id = 'cus_unique_preflight'
  where id = '91000000-0000-4000-8000-000000000001';
  begin
    insert into public.salons (
      id, slug, name, phone, stripe_customer_id
    ) values (
      '91000000-0000-4000-8000-000000000003',
      'stripe-ledger-duplicate',
      'Stripe Ledger Duplicate',
      '+15550000004',
      'cus_unique_preflight'
    );
    raise exception 'duplicate Stripe customer binding was accepted';
  exception
    when unique_violation then null;
  end;

  update public.salons
  set stripe_subscription_id = 'sub_unique_preflight'
  where id = '91000000-0000-4000-8000-000000000001';
  begin
    insert into public.salons (
      id, slug, name, phone, stripe_subscription_id
    ) values (
      '91000000-0000-4000-8000-000000000004',
      'stripe-ledger-subscription-duplicate',
      'Stripe Ledger Subscription Duplicate',
      '+15550000005',
      'sub_unique_preflight'
    );
    raise exception 'duplicate Stripe subscription binding was accepted';
  exception
    when unique_violation then null;
  end;
  update public.salons
  set stripe_subscription_id = null
  where id = '91000000-0000-4000-8000-000000000001';

  select * into v_first
  from public.claim_stripe_subscription_checkout(
    '91000000-0000-4000-8000-000000000001',
    'pro',
    repeat('a', 64),
    v_now
  );
  if v_first.outcome <> 'acquired' or v_first.lease_token is null then
    raise exception 'expected acquired first Checkout claim, got %', v_first.outcome;
  end if;

  select public.finish_stripe_subscription_checkout(
    '91000000-0000-4000-8000-000000000001',
    v_first.lease_token,
    'open',
    'cs_db_replay_one',
    'https://checkout.stripe.test/cs_db_replay_one',
    v_now + interval '1 hour',
    null,
    v_now
  ) into v_ok;
  if not v_ok then
    raise exception 'failed to publish first Checkout attempt';
  end if;

  select public.mark_stripe_subscription_checkout_completed(
    '91000000-0000-4000-8000-000000000001',
    'cs_db_replay_one',
    'cus_db_replay_one',
    'sub_db_replay_one',
    'payment_pending',
    v_now + interval '1 minute'
  ) into v_mark;
  if v_mark <> 'marked' then
    raise exception 'expected first completion mark, got %', v_mark;
  end if;

  select public.mark_stripe_subscription_checkout_completed(
    '91000000-0000-4000-8000-000000000001',
    'cs_db_replay_one',
    'cus_db_replay_one',
    'sub_db_replay_one',
    'payment_succeeded',
    v_now + interval '2 minutes'
  ) into v_mark;
  if v_mark <> 'duplicate' then
    raise exception 'expected idempotent success replay, got %', v_mark;
  end if;

  -- A late failed event must never downgrade provider-confirmed success.
  perform public.mark_stripe_subscription_checkout_completed(
    '91000000-0000-4000-8000-000000000001',
    'cs_db_replay_one',
    'cus_db_replay_one',
    'sub_db_replay_one',
    'payment_failed',
    v_now + interval '3 minutes'
  );
  select provider_status into v_status
  from public.stripe_subscription_checkout_attempts
  where salon_id = '91000000-0000-4000-8000-000000000001';
  if v_status <> 'payment_succeeded' then
    raise exception 'late failure downgraded durable success to %', v_status;
  end if;

  select * into v_next
  from public.claim_stripe_subscription_checkout(
    '91000000-0000-4000-8000-000000000001',
    'pro',
    repeat('a', 64),
    v_now + interval '48 hours'
  );
  if v_next.outcome <> 'active_subscription' then
    raise exception 'completed Checkout rotated after expiry: %', v_next.outcome;
  end if;

  update public.salons
  set subscription_status = 'canceled',
      subscription_plan = 'free',
      stripe_subscription_id = null
  where id = '91000000-0000-4000-8000-000000000001';
  perform public.close_stripe_subscription_checkout(
    '91000000-0000-4000-8000-000000000001',
    'sub_db_replay_one',
    'subscription_terminal',
    v_now + interval '49 hours'
  );
  select * into v_next
  from public.claim_stripe_subscription_checkout(
    '91000000-0000-4000-8000-000000000001',
    'pro',
    repeat('b', 64),
    v_now + interval '50 hours'
  );
  select generation into v_generation
  from public.stripe_subscription_checkout_attempts
  where salon_id = '91000000-0000-4000-8000-000000000001';
  if v_next.outcome <> 'acquired' or v_generation <> 2 then
    raise exception 'terminal subscription did not rotate exactly once: %, %',
      v_next.outcome, v_generation;
  end if;

  -- Local URL expiry alone leases provider reconciliation; it never rotates.
  select * into v_first
  from public.claim_stripe_subscription_checkout(
    '91000000-0000-4000-8000-000000000002',
    'premium',
    repeat('c', 64),
    v_now
  );
  perform public.finish_stripe_subscription_checkout(
    '91000000-0000-4000-8000-000000000002',
    v_first.lease_token,
    'open',
    'cs_db_reconcile_two',
    'https://checkout.stripe.test/cs_db_reconcile_two',
    v_now + interval '1 hour',
    null,
    v_now
  );
  select * into v_reconcile
  from public.claim_stripe_subscription_checkout(
    '91000000-0000-4000-8000-000000000002',
    'premium',
    repeat('c', 64),
    v_now + interval '2 hours'
  );
  if v_reconcile.outcome <> 'reconcile' or v_reconcile.lease_token is null then
    raise exception 'expired URL did not request reconciliation: %', v_reconcile.outcome;
  end if;
  select public.reconcile_stripe_subscription_checkout(
    '91000000-0000-4000-8000-000000000002',
    v_reconcile.lease_token,
    'completed',
    null,
    'cus_db_reconcile_two',
    'sub_db_reconcile_two',
    'payment_succeeded',
    null,
    v_now + interval '2 hours 1 minute'
  ) into v_ok;
  if not v_ok then
    raise exception 'provider reconciliation lease was not fenced';
  end if;

  select * into v_event
  from public.claim_stripe_webhook_event(
    'evt_db_replay_one',
    'checkout.session.completed',
    v_now
  );
  if v_event.outcome <> 'acquired' then
    raise exception 'expected acquired event claim, got %', v_event.outcome;
  end if;
  perform public.finish_stripe_webhook_event(
    'evt_db_replay_one',
    v_event.lease_token,
    'processed',
    null,
    v_now
  );
  select * into v_event
  from public.claim_stripe_webhook_event(
    'evt_db_replay_one',
    'checkout.session.completed',
    v_now + interval '1 minute'
  );
  if v_event.outcome <> 'duplicate' then
    raise exception 'processed event replay was not fenced: %', v_event.outcome;
  end if;
end;
$test$;

rollback;
