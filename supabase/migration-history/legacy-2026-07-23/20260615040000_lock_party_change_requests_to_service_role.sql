-- MEDIUM-1: party_link_change_requests had open anon policies — INSERT
-- WITH CHECK (true) (anon spam) and SELECT qual=true (cross-tenant read). Both
-- the legit guest insert (submitPartyChangeRequest — validates token + claim
-- server-side first) and the dashboard read (loadPartyCards) use service-role
-- (bypasses RLS), so dropping these closes the abuse surface with no app impact.
DROP POLICY IF EXISTS "anon_insert_party_change_requests" ON public.party_link_change_requests;
DROP POLICY IF EXISTS "anon_select_party_change_requests" ON public.party_link_change_requests;
