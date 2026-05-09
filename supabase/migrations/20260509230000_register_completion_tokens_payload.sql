-- Server-side flow state for the multi-step register flow.
-- Adds a `payload jsonb` column to `register_completion_tokens` so steps
-- after OTP verify (/register/setup) can recover their state when
-- sessionStorage is unavailable (reload, cross-tab, browser restart).
--
-- Existing rows get an empty object so downstream code can always
-- destructure without null-guards. RLS unchanged — service-role-only
-- writes via the `verifyRegisterOtp` server action; reads also go
-- through a service-role action that gates on the token uuid (the
-- token itself is the capability).

alter table public.register_completion_tokens
  add column if not exists payload jsonb not null default '{}'::jsonb;

comment on column public.register_completion_tokens.payload is
  'Server-side flow state for the register multi-step. Today carries `phone_digits` (E.164 digits, no plus) and `returning_owner` (boolean). Extend additively; clients use this as a fallback when sessionStorage is unavailable.';
