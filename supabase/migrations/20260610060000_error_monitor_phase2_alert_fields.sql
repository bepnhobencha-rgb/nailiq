-- Phase 2: AI triage + alerts (applied to prod 2026-06-10 via MCP; file for parity).
-- alerted_at dedups alert emails (one per error). error_alert_email is the
-- operator recipient, in platform_settings so it's editable without a redeploy.
alter table public.error_logs add column if not exists alerted_at timestamptz;
alter table public.platform_settings add column if not exists error_alert_email text;
