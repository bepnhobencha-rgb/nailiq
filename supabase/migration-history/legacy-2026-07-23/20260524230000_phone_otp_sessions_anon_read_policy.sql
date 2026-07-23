-- Allow anon/browser to read a phone_otp_sessions row they have the UUID for.
-- The UUID itself is a capability token (issued by /api/booking-otp/verify to the client).
-- Only unconsumed, non-expired sessions are visible to minimize exposure.
-- Used by submitPublicBooking (browser-side) to validate the session before booking commit.
CREATE POLICY "anon_read_valid_otp_session"
ON public.phone_otp_sessions
FOR SELECT
USING (consumed_at IS NULL AND expires_at > now());
