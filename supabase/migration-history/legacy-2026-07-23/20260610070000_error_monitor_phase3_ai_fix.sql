-- Phase 3: AI-drafted fix (applied to prod 2026-06-10 via MCP; file for parity).
alter table public.error_logs add column if not exists fix_proposal text;
alter table public.error_logs add column if not exists fix_file text;
alter table public.error_logs add column if not exists fix_pr_url text;
-- Fine-grained GitHub PAT (single repo, contents + pull-requests write) used
-- ONLY to open the draft PR. Configurable without a redeploy.
alter table public.platform_settings add column if not exists github_fix_token text;
