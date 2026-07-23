-- Self-service Wix onboarding: store each salon's own Wix credentials so a new
-- salon can connect by pasting its API key + site ID in Admin Settings — no env
-- vars, no deploy. The client falls back to the WIX_API_KEY env var when a row
-- has no key (keeps the original single-tenant Tech Nails setup working).
--
-- Plaintext + service-role-only RLS, consistent with platform_settings / Twilio
-- secret storage already in this codebase (no app-level encryption exists yet).

ALTER TABLE public.wix_integrations
  ADD COLUMN IF NOT EXISTS wix_api_key            text,  -- account API key (Bookings Manage scope)
  ADD COLUMN IF NOT EXISTS wix_webhook_public_key text,  -- PEM public key for RSA-SHA256 webhook verify
  ADD COLUMN IF NOT EXISTS wix_default_resource_id text; -- fallback Wix staff resource for unmapped techs

COMMENT ON COLUMN public.wix_integrations.wix_api_key IS
  'Per-salon Wix account API key (Bookings Manage scope). NULL => fall back to WIX_API_KEY env.';
COMMENT ON COLUMN public.wix_integrations.wix_webhook_public_key IS
  'Per-salon Wix custom-app public key (PEM) for webhook RSA verify. NULL => fall back to WIX_WEBHOOK_PUBLIC_KEY env.';
