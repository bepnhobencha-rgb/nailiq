-- Email verification tokens for the salon owner recovery-email flow.
-- One token row per (salon_id, email) verification attempt; the
-- /api/verify-email route validates the token then flips
-- `salons.email_verified = true` and burns the token.
--
-- Server-only writes via the service-role client. Reads are also
-- server-only (the verify endpoint runs in the Node runtime); RLS
-- denies anon/authenticated by default since no policies are added.

create table if not exists public.email_verification_tokens (
  token uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  email text not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists email_verification_tokens_salon_idx
  on public.email_verification_tokens (salon_id);

-- Cleanup helper for ops: lets a future cron job remove rows older than
-- 7 days (already-used or expired). Not wired up here.
create index if not exists email_verification_tokens_created_idx
  on public.email_verification_tokens (created_at);

alter table public.email_verification_tokens enable row level security;

-- No policies — service role bypasses; anon/authenticated denied by
-- default. The verify endpoint runs server-side and uses the service
-- role to look up + burn the token.

comment on table public.email_verification_tokens is
  'Short-lived single-use tokens for salon recovery-email verification. Service-role-only; RLS denies all client roles.';
