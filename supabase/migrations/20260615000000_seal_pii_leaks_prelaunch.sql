-- Pre-launch security: seal confirmed anon/cross-tenant PII leaks.
-- Each fix verified non-breaking: the app reaches these via service-role
-- (bypasses grants/RLS) or via the member-scoped policy, never via anon.

-- C1 (CRITICAL) — search_salon_clients was EXECUTE-granted to anon/authenticated,
-- letting any visitor dump a salon's full customer PII (name/phone/email/notes/
-- spend) by passing a salon_id. Sole caller (loadClientProfilesAction) runs it
-- through createServiceRoleClient AFTER a desk-role auth gate, so revoking the
-- anon/authenticated grant closes the hole without touching the app.
REVOKE EXECUTE ON FUNCTION public.search_salon_clients(uuid, text, integer, integer)
  FROM anon, authenticated, public;

-- H2 (HIGH) — salon_resources had an open "anon read" (qual=true) policy granting
-- {anon,authenticated} SELECT across all tenants. Members keep read access via the
-- existing "members write salon_resources" ALL policy (salon-scoped); only the
-- dashboard reads this table (loadOwnerPulse, via member/service-role).
DROP POLICY IF EXISTS "anon read salon_resources" ON public.salon_resources;

-- M1 (MEDIUM) — client_profiles carried qual=true PUBLIC INSERT/UPDATE policies.
-- Not currently exploitable (anon/authenticated lack the table write grant) but a
-- single reflexive GRANT would turn it into cross-tenant customer-record tampering.
-- All writes go through SECURITY DEFINER RPCs / service-role; drop the open policies.
DROP POLICY IF EXISTS "public update client_profiles" ON public.client_profiles;
DROP POLICY IF EXISTS "public insert client_profiles" ON public.client_profiles;
