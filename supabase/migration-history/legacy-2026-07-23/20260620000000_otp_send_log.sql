-- Server-side SMS-OTP send throttle backing store.
--
-- The booking OTP send route (`/api/booking-otp/send`) had NO server-side guard
-- on the SMS channel — only a client-side 60s cooldown, which is bypassable
-- (direct API call, second tab, page reload, React double-fire). That let the
-- same phone trigger multiple Twilio Verify charges. This table records each SMS
-- send so the route can enforce: ≥ 30s between sends to one phone, ≤ 5 per 15 min.
-- (The email channel already rate-limits itself via `email_otp_codes`.)
--
-- Service-role only: the route uses the service-role client, which bypasses RLS.
-- RLS is enabled with NO policies so anon/authenticated can neither read nor write.

CREATE TABLE IF NOT EXISTS public.otp_send_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id   uuid NOT NULL,
  phone      text NOT NULL,
  channel    text NOT NULL DEFAULT 'sms',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Lookup is always (salon, phone, channel) ordered by recency within a window.
CREATE INDEX IF NOT EXISTS otp_send_log_lookup_idx
  ON public.otp_send_log (salon_id, phone, channel, created_at DESC);

ALTER TABLE public.otp_send_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.otp_send_log FROM anon, authenticated;
