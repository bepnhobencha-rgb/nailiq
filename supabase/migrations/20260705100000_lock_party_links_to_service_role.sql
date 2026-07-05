-- SECURITY (privacy leak): party_links and party_link_claims shipped with
-- open anonymous SELECT policies (USING (true)) from 20260527200000. That let
-- anyone with the public anon key read every row directly via PostgREST —
-- including party_link_claims.member_phone, and party_links.token (the opaque
-- capability that gates claim_party_slot). The original comments assumed
-- "column-level security in the server action" would protect phones, but RLS
-- SELECT is table-level: PostgREST callers bypass the server action entirely.
--
-- Every legitimate reader already uses service-role (bypasses RLS):
--   • loadPartyLinkPage / all of partyLinkActions.ts  → createServiceRoleClient
--   • /party/[token]/page.tsx (page + flag lookup)     → createServiceRoleClient
--   • groupMemberRsvpActions.ts (confirm/decline)       → createServiceRoleClient
--   • loadPartyCardsAction / dashboard readers          → service-role
-- and the anon-facing write path is the SECURITY DEFINER RPC claim_party_slot,
-- which does not depend on an anon SELECT policy.
--
-- So dropping the anon SELECT policies closes the leak with zero app impact —
-- mirroring 20260615040000 which already did this for party_link_change_requests.

DROP POLICY IF EXISTS "anon_select_party_links"       ON public.party_links;
DROP POLICY IF EXISTS "anon_select_party_link_claims" ON public.party_link_claims;
