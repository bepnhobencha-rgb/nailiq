-- Public booking traffic uses the anonymous RPC boundary. Authenticated salon
-- users do not need this capability; removing it keeps the intentional
-- SECURITY DEFINER allowlist least-privileged on upgraded QA databases where
-- the preceding migration was already applied.
REVOKE EXECUTE ON FUNCTION public.create_public_capacity_rescue_request(
  uuid, uuid, text, uuid, uuid, date, text, integer,
  text, text, text, text, jsonb
) FROM PUBLIC, authenticated;

GRANT EXECUTE ON FUNCTION public.create_public_capacity_rescue_request(
  uuid, uuid, text, uuid, uuid, date, text, integer,
  text, text, text, text, jsonb
) TO anon, service_role;
