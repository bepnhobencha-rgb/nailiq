-- One-time QR/link invite tokens for staff onboarding.
-- Owner creates a token → sends QR or link → staff scans/clicks →
-- signs in with Google → /auth/callback claims the token → membership created.
CREATE TABLE IF NOT EXISTS public.salon_invite_tokens (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  token       text        UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
  salon_id    uuid        NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  staff_id    uuid        NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  role        text        NOT NULL CHECK (role IN ('admin', 'receptionist')),
  created_by  uuid        REFERENCES auth.users(id),
  expires_at  timestamptz NOT NULL DEFAULT NOW() + INTERVAL '48 hours',
  used_at     timestamptz,
  used_by_user_id uuid   REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_salon_invite_tokens_token    ON public.salon_invite_tokens(token);
CREATE INDEX IF NOT EXISTS idx_salon_invite_tokens_staff_id ON public.salon_invite_tokens(staff_id);
CREATE INDEX IF NOT EXISTS idx_salon_invite_tokens_salon_id ON public.salon_invite_tokens(salon_id);

-- Only service_role accesses this table (all operations go through server actions).
ALTER TABLE public.salon_invite_tokens ENABLE ROW LEVEL SECURITY;
