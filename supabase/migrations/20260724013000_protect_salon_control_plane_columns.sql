-- The salons row mixes day-to-day business settings with control-plane state.
-- Row-level UPDATE authorization alone cannot prevent an owner/admin token from
-- forging subscription, Stripe, trial, quota, A2P, or SuperAdmin-managed data.
--
-- Keep normal owner/admin settings writable under RLS, but enforce two narrower
-- column boundaries:
--   1. platform/external-system mirrors are service-role only;
--   2. structural/payment-provider choices are owner-only.

create or replace function public.enforce_salon_control_plane_columns()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  membership_role text;
begin
  -- Service-role API calls and trusted database routines are the only writers
  -- for external-system mirrors and platform control-plane state.
  if (select auth.role()) = 'service_role'
     or current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  if exists (
    select 1
    from unnest(array[
      'created_at',
      'stripe_customer_id',
      'stripe_subscription_id',
      'subscription_plan',
      'subscription_status',
      'subscription_current_period_end',
      'plan_override',
      'is_beta',
      'admin_notes',
      'superadmin_locked_at',
      'voice_ai_sessions_this_month',
      'voice_ai_sessions_limit',
      'voice_ai_sessions_reset_at',
      'basic_mode_forced',
      'stripe_connect_account_id',
      'stripe_connect_charges_enabled',
      'stripe_connect_details_submitted',
      'sms_a2p_registered',
      'trial_started_at',
      'trial_ends_at'
    ]) as protected(column_name)
    where to_jsonb(new) -> protected.column_name
      is distinct from to_jsonb(old) -> protected.column_name
  ) then
    raise insufficient_privilege
      using message = 'salon control-plane columns require service-role authorization';
  end if;

  -- A member may invalidate an email while changing it, but only the trusted
  -- verification route may promote the address to verified.
  if new.email_verified is distinct from old.email_verified
     and new.email_verified is true then
    raise insufficient_privilege
      using message = 'email verification requires service-role authorization';
  end if;

  if exists (
    select 1
    from unnest(array[
      'vertical',
      'archived_at',
      'payment_provider'
    ]) as owner_only(column_name)
    where to_jsonb(new) -> owner_only.column_name
      is distinct from to_jsonb(old) -> owner_only.column_name
  ) then
    select sm.role
      into membership_role
    from public.salon_members as sm
    where sm.salon_id = old.id
      and sm.user_id = (select auth.uid())
    limit 1;

    if membership_role is distinct from 'owner' then
      raise insufficient_privilege
        using message = 'salon structural and payment-provider changes require owner authorization';
    end if;
  end if;

  return new;
end
$function$;

drop trigger if exists salons_protect_control_plane_columns
  on public.salons;

create trigger salons_protect_control_plane_columns
before update on public.salons
for each row
execute function public.enforce_salon_control_plane_columns();
