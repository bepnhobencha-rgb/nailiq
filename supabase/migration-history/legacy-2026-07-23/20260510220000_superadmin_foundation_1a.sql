-- 2026-05-10 — Superadmin Foundation Shell V1 (Phase 1A)
--
-- Per docs/PERMISSION_MATRIX.md §8 and docs/DASHBOARD_LAYOUT_RULES.md §10.
-- ADR: decisions-log.md 2026-05-10.
--
-- Extends PR #82's superadmins table with multi-role support and adds
-- companion tables for audit logging, platform-wide feature flags, and
-- platform announcements. All changes are strictly additive — no existing
-- data is touched beyond the column-default backfill of role='founder'
-- on existing superadmin rows.

-- ============================================================================
-- 1. superadmins — add role, revocation, and audit columns
-- ============================================================================

alter table public.superadmins
  add column if not exists role text not null default 'founder'
    check (role in (
      'founder',
      'ops_admin',
      'support_admin',
      'billing_admin',
      'ai_admin',
      'readonly_analyst'
    )),
  add column if not exists revoked_at timestamptz,
  add column if not exists created_by uuid references auth.users(id) on delete set null;

comment on column public.superadmins.role is
  'Platform-scoped role (PERMISSION_MATRIX.md §8.2). One of: founder, '
  'ops_admin, support_admin, billing_admin, ai_admin, readonly_analyst. '
  'Defaults to founder so PR #82 rows backfill correctly without manual SQL.';
comment on column public.superadmins.revoked_at is
  'Soft delete. Non-null rows are inert — getSuperadminRole returns null. '
  'Hard delete only via cascade from auth.users (per existing FK).';
comment on column public.superadmins.created_by is
  'Audit — which superadmin promoted this row. NULL if seeded out-of-band '
  '(e.g. founder bootstrap via service-role SQL).';

-- ============================================================================
-- 2. superadmin_audit_logs — append-only trail for privileged actions
-- ============================================================================

create table if not exists public.superadmin_audit_logs (
  id              uuid primary key default gen_random_uuid(),
  actor_user_id   uuid references auth.users(id) on delete set null,
  actor_role      text not null,
  action          text not null,
  target_kind     text,
  target_id       uuid,
  before_jsonb    jsonb,
  after_jsonb     jsonb,
  reason          text,
  created_at      timestamptz not null default now()
);

comment on table public.superadmin_audit_logs is
  'Append-only audit trail for /superadmin/* mutations + impersonation. '
  'PERMISSION_MATRIX.md §8.5 requires every mutating server action to '
  'write a row here BEFORE returning. Audit failure halts the mutation '
  '(audit-or-rollback).';
comment on column public.superadmin_audit_logs.actor_user_id is
  'auth.users.id of the superadmin who took the action. NULL only when '
  'the underlying auth user was later deleted (set null cascade preserves '
  'the audit row).';
comment on column public.superadmin_audit_logs.actor_role is
  'Snapshot of actor role at action time. Recorded explicitly because '
  'roles change over time (revoked, demoted).';
comment on column public.superadmin_audit_logs.action is
  'Action verb. Recognised values include: impersonate_enter, '
  'impersonate_exit, flag_set, flag_unset, announcement_publish, '
  'announcement_expire, salon_lock, salon_unlock, plan_override_set, '
  'feature_flag_set. Unknown values are accepted (forward-compat).';
comment on column public.superadmin_audit_logs.target_kind is
  'Polymorphic target type: salon, user, flag, announcement. NULL when '
  'the action has no per-row target (e.g. session-level events).';
comment on column public.superadmin_audit_logs.target_id is
  'Polymorphic target UUID — interpret with target_kind. Not FK-constrained '
  'because target_kind varies. Cleanup of orphaned rows is acceptable.';
comment on column public.superadmin_audit_logs.before_jsonb is
  'Snapshot of relevant state BEFORE the mutation. NULL on create actions.';
comment on column public.superadmin_audit_logs.after_jsonb is
  'Snapshot of relevant state AFTER the mutation. NULL on delete or '
  'read-only actions (e.g. impersonate_enter without changes).';
comment on column public.superadmin_audit_logs.reason is
  'Free-text rationale supplied by the superadmin at action time. '
  'Required for impersonation per PERMISSION_MATRIX.md §8.4; '
  'optional elsewhere but encouraged for audit clarity.';

-- Query patterns:
--   1. "Show all actions by actor X" → actor_user_id + created_at desc.
--   2. "Show all actions against salon Y" → target_kind + target_id + created_at desc.
create index if not exists superadmin_audit_logs_actor_created_idx
  on public.superadmin_audit_logs (actor_user_id, created_at desc);
create index if not exists superadmin_audit_logs_target_created_idx
  on public.superadmin_audit_logs (target_kind, target_id, created_at desc);

alter table public.superadmin_audit_logs enable row level security;

-- Read: any active superadmin can read the full audit log.
-- Phase 1F may tighten this to role-aware filtering (e.g. billing_admin
-- only sees billing-target rows). For Foundation V1, broad read is OK
-- because audit logs are an internal accountability surface, not user-
-- facing.
drop policy if exists "audit_logs_select_for_superadmins" on public.superadmin_audit_logs;
create policy "audit_logs_select_for_superadmins" on public.superadmin_audit_logs
  for select to authenticated
  using (
    exists (
      select 1
      from public.superadmins s
      where s.user_id = auth.uid()
        and s.revoked_at is null
    )
  );

-- No insert/update/delete policies for authenticated — service-role only
-- via server actions. Audit log rows are immutable by design.

-- ============================================================================
-- 3. platform_feature_flags — platform-wide flags (read-by-all)
-- ============================================================================
--
-- Distinct from `salons.feature_flags` JSONB (per-salon, set via the
-- SuperAdminPanel from PR #82). This table holds platform-level flags:
--   * 'beta_signup_open'   — public registration gating
--   * 'maintenance_mode'   — global read-only banner
--   * 'ai_assistants_beta' — feature exposure gate
-- Read by every authenticated client; written by service-role only.

create table if not exists public.platform_feature_flags (
  key         text primary key,
  enabled     boolean not null default false,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null
);

comment on table public.platform_feature_flags is
  'Platform-wide feature flags read by all authenticated clients. '
  'Distinct from salons.feature_flags JSONB (per-salon overrides). '
  'Writes happen exclusively via service-role-mediated superadmin actions.';

alter table public.platform_feature_flags enable row level security;

drop policy if exists "platform_flags_read_authenticated" on public.platform_feature_flags;
create policy "platform_flags_read_authenticated" on public.platform_feature_flags
  for select to authenticated
  using (true);

-- No insert/update/delete policies — service-role only.

-- ============================================================================
-- 4. platform_announcements — broadcast banners to operators
-- ============================================================================

create table if not exists public.platform_announcements (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  body         text not null,
  severity     text not null default 'info'
    check (severity in ('info', 'warning', 'urgent')),
  target       text not null default 'all'
    check (target in ('all', 'owners', 'staff', 'superadmins')),
  published_at timestamptz,
  expires_at   timestamptz,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.platform_announcements is
  'Broadcast messages to NailIQ operators (owners, staff, superadmins). '
  'Surfaces in dashboards as banners filtered by target, severity, and '
  '(published_at, expires_at) window. Writes via superadmin actions only.';
comment on column public.platform_announcements.published_at is
  'NULL = draft (not yet visible to anyone). Set to publish.';
comment on column public.platform_announcements.expires_at is
  'NULL = no expiry. Past expires_at = hidden by application filter; '
  'row is retained for audit / re-publish.';
comment on column public.platform_announcements.target is
  'Audience scope. Filtering happens at the application layer; RLS '
  'gates only on authentication status.';

create index if not exists platform_announcements_target_published_idx
  on public.platform_announcements (target, published_at desc);

alter table public.platform_announcements enable row level security;

drop policy if exists "announcements_read_authenticated" on public.platform_announcements;
create policy "announcements_read_authenticated" on public.platform_announcements
  for select to authenticated
  using (true);

-- No insert/update/delete policies — service-role only.

-- ============================================================================
-- 5. Shared updated_at trigger
-- ============================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_platform_flags_updated_at on public.platform_feature_flags;
create trigger set_platform_flags_updated_at
  before update on public.platform_feature_flags
  for each row
  execute function public.set_updated_at();

drop trigger if exists set_platform_announcements_updated_at on public.platform_announcements;
create trigger set_platform_announcements_updated_at
  before update on public.platform_announcements
  for each row
  execute function public.set_updated_at();
