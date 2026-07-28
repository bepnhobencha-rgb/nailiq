-- Append-only human evidence for salon go-live decisions.
--
-- Automated readiness is deliberately not stored here: it is recalculated
-- from current salon data on every read. This table records only explicit
-- human attestations and their revocations, including who acted and when.
CREATE TABLE public.salon_go_live_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  check_key text NOT NULL CHECK (
    check_key IN (
      'hours_confirmed',
      'otp_policy_confirmed',
      'live_rehearsal_completed',
      'owner_approved'
    )
  ),
  action text NOT NULL CHECK (action IN ('attest', 'revoke')),
  evidence_note text NOT NULL CHECK (
    char_length(btrim(evidence_note)) BETWEEN 10 AND 500
  ),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_role text NOT NULL CHECK (actor_role IN ('owner', 'admin')),
  readiness_snapshot_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT salon_go_live_owner_approval_actor_check CHECK (
    check_key <> 'owner_approved' OR actor_role = 'owner'
  ),
  CONSTRAINT salon_go_live_snapshot_hash_check CHECK (
    readiness_snapshot_hash IS NULL
    OR readiness_snapshot_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT salon_go_live_owner_approval_snapshot_check CHECK (
    check_key <> 'owner_approved'
    OR action = 'revoke'
    OR readiness_snapshot_hash IS NOT NULL
  )
);

COMMENT ON TABLE public.salon_go_live_attestations IS
  'Append-only human attestations/revocations for salon go-live readiness. Automated gates are recalculated from current salon data.';
COMMENT ON COLUMN public.salon_go_live_attestations.readiness_snapshot_hash IS
  'SHA-256 of the technical readiness inputs at owner approval; a changed configuration invalidates the approval in the application.';

CREATE INDEX salon_go_live_attestations_history_idx
  ON public.salon_go_live_attestations (salon_id, check_key, created_at DESC, id DESC);

ALTER TABLE public.salon_go_live_attestations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "salon managers read go-live attestations"
  ON public.salon_go_live_attestations
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.salon_members sm
      WHERE sm.salon_id = salon_go_live_attestations.salon_id
        AND sm.user_id = (SELECT auth.uid())
        AND sm.role IN ('owner', 'admin')
    )
  );

CREATE POLICY "salon managers append go-live attestations"
  ON public.salon_go_live_attestations
  FOR INSERT
  TO authenticated
  WITH CHECK (
    actor_user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.salon_members sm
      WHERE sm.salon_id = salon_go_live_attestations.salon_id
        AND sm.user_id = (SELECT auth.uid())
        AND sm.role = salon_go_live_attestations.actor_role
        AND sm.role IN ('owner', 'admin')
        AND (
          salon_go_live_attestations.check_key <> 'owner_approved'
          OR sm.role = 'owner'
        )
    )
  );

-- Managers may read their audit history through RLS, but all writes are
-- server-only. This prevents an authenticated Owner from bypassing application
-- readiness and prerequisite checks by inserting directly through the Data API.
-- There are intentionally no authenticated INSERT/UPDATE/DELETE grants.
REVOKE ALL ON TABLE public.salon_go_live_attestations FROM anon, authenticated;
GRANT SELECT ON TABLE public.salon_go_live_attestations TO authenticated;
GRANT ALL ON TABLE public.salon_go_live_attestations TO service_role;
