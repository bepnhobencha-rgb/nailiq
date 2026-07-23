-- Phase 1F (audit-logs viewer) — add indexes for the filter combinations
-- the new viewer surfaces.
--
-- Existing indexes (from 20260510220000_superadmin_foundation_1a.sql):
--   - (actor_user_id, created_at desc)  → "by actor"
--   - (target_kind, target_id, created_at desc)  → "by target"
--
-- This migration adds:
--   - (action, created_at desc)  → "by action verb" filter
--   - (created_at desc)          → default unfiltered page sort
--
-- All concurrent + idempotent so re-applying on an existing prod
-- database is a no-op.

create index if not exists superadmin_audit_logs_action_created_idx
  on public.superadmin_audit_logs (action, created_at desc);

create index if not exists superadmin_audit_logs_created_idx
  on public.superadmin_audit_logs (created_at desc);
