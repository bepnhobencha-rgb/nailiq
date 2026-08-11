-- Reversible tenant suspension state. `archived_at` remains the single gate
-- already used by public booking, dashboard lookup, and autonomous workers.
-- These columns explain why the tenant is paused and retain only operational
-- booleans needed to restore NailIQ. No Wix/Square credentials are copied.
alter table public.salons
  add column if not exists tenant_pause_reason text,
  add column if not exists tenant_pause_note text,
  add column if not exists tenant_pause_snapshot jsonb,
  add column if not exists tenant_paused_by uuid references auth.users(id) on delete set null,
  add column if not exists payment_grace_ends_at timestamptz;

alter table public.salons
  drop constraint if exists salons_tenant_pause_reason_check;

alter table public.salons
  add constraint salons_tenant_pause_reason_check
  check (tenant_pause_reason is null or tenant_pause_reason in ('manual', 'non_payment'));

create index if not exists salons_past_due_grace_idx
  on public.salons (payment_grace_ends_at)
  where subscription_status = 'past_due'
    and archived_at is null
    and payment_grace_ends_at is not null;

comment on column public.salons.tenant_pause_reason is
  'Why NailIQ is paused: manual or non_payment. Does not alter Wix/Square.';
comment on column public.salons.tenant_pause_snapshot is
  'Operational NailIQ booleans captured before pause for exact, reversible restore.';
comment on column public.salons.payment_grace_ends_at is
  'Past-due deadline. The tenant-pause cron archives NailIQ after this timestamp.';

-- Existing archived tenants predate the richer state. Label them without
-- inventing a configuration snapshot.
update public.salons
set tenant_pause_reason = 'manual'
where archived_at is not null
  and tenant_pause_reason is null;

-- Keep all pause state in the control plane. Ordinary salon members must not
-- forge a pause reason, snapshot, operator, or payment deadline.
create or replace function public.protect_tenant_pause_control_plane()
returns trigger
language plpgsql
security invoker
set search_path = public
as $function$
begin
  if (select auth.role()) is distinct from 'service_role'
     and (select auth.uid()) is not null
     and (
       new.tenant_pause_reason is distinct from old.tenant_pause_reason or
       new.tenant_pause_note is distinct from old.tenant_pause_note or
       new.tenant_pause_snapshot is distinct from old.tenant_pause_snapshot or
       new.tenant_paused_by is distinct from old.tenant_paused_by or
       new.payment_grace_ends_at is distinct from old.payment_grace_ends_at
     ) then
    raise insufficient_privilege
      using message = 'tenant pause control-plane columns require service-role authorization';
  end if;
  return new;
end;
$function$;

drop trigger if exists protect_tenant_pause_control_plane on public.salons;
create trigger protect_tenant_pause_control_plane
before update of tenant_pause_reason, tenant_pause_note, tenant_pause_snapshot,
  tenant_paused_by, payment_grace_ends_at
on public.salons
for each row execute function public.protect_tenant_pause_control_plane();

-- Register the hourly payment-pause worker with the existing heartbeat/history
-- fence so failed runs are visible in Superadmin operations.
alter table public.ai_execution_worker_state
  drop constraint if exists ai_execution_worker_state_name_check;
alter table public.ai_execution_worker_state
  add constraint ai_execution_worker_state_name_check
  check (worker_name in (
    'ai_execution', 'ai_manager', 'campaign_scheduler',
    'close_stale_in_progress', 'error_triage', 'minh_learn',
    'nail_tryon_cleanup', 'noshow_card_nudge', 'noshow_charge_retry',
    'release_review', 'reminders', 'send_pending_notifications', 'spend_sync',
    'square_email_consent', 'square_sync', 'tenant_payment_pause',
    'waitlist_advance', 'wix_sync'
  ));

alter table public.ai_worker_runs
  drop constraint if exists ai_worker_runs_worker_name_check;
alter table public.ai_worker_runs
  add constraint ai_worker_runs_worker_name_check
  check (worker_name in (
    'ai_execution', 'ai_manager', 'campaign_scheduler',
    'close_stale_in_progress', 'error_triage', 'minh_learn',
    'nail_tryon_cleanup', 'noshow_card_nudge', 'noshow_charge_retry',
    'release_review', 'reminders', 'send_pending_notifications', 'spend_sync',
    'square_email_consent', 'square_sync', 'tenant_payment_pause',
    'waitlist_advance', 'wix_sync'
  ));

create or replace function public.ai_cron_worker_supported(p_worker_name text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select p_worker_name = any (array[
    'ai_execution', 'ai_manager', 'campaign_scheduler',
    'close_stale_in_progress', 'error_triage', 'minh_learn',
    'nail_tryon_cleanup', 'noshow_card_nudge', 'noshow_charge_retry',
    'release_review', 'reminders', 'send_pending_notifications', 'spend_sync',
    'square_email_consent', 'square_sync', 'tenant_payment_pause',
    'waitlist_advance', 'wix_sync'
  ]::text[]);
$$;

revoke all on function public.ai_cron_worker_supported(text)
  from public, anon, authenticated;
grant execute on function public.ai_cron_worker_supported(text)
  to service_role;
