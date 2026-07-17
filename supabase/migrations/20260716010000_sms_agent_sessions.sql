-- AI Receptionist Module 4 — SMS transport.
--
-- SMS is stateless per webhook (each inbound text is a fresh HTTP request), but
-- a booking conversation is multi-turn ("cancel my appointment" → "which one?"
-- → "the Friday one"). This table holds the rolling Anthropic message history
-- per (salon, customer phone) so the SAME agent brain can carry context across
-- texts. One row per customer-per-salon; the newest turns overwrite the oldest
-- (the app trims before persisting).
--
-- Access is service-role only (the /api/twilio/sms webhook uses the service-role
-- client). RLS is enabled with NO policies and grants are revoked from anon /
-- authenticated so a leaked anon key cannot read customers' conversation logs.

CREATE TABLE IF NOT EXISTS public.sms_agent_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id       uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  phone          text NOT NULL,                       -- customer phone, canonical E.164
  messages       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- Anthropic message history (trimmed)
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_agent_sessions_salon_phone_uniq UNIQUE (salon_id, phone)
);

-- Fast lookup for the periodic staleness purge (old conversations expire).
CREATE INDEX IF NOT EXISTS sms_agent_sessions_updated_idx
  ON public.sms_agent_sessions (updated_at);

ALTER TABLE public.sms_agent_sessions ENABLE ROW LEVEL SECURITY;

-- No policies: only the service-role client (which bypasses RLS) may touch this.
REVOKE ALL ON public.sms_agent_sessions FROM anon, authenticated;
