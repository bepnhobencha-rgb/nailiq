\set ON_ERROR_STOP on

BEGIN;
SET LOCAL TIME ZONE 'UTC';

INSERT INTO auth.users (id, email, created_at) VALUES
  ('40000000-0000-4000-8000-000000000071', 'qa-v1-fast-track-owner@nailiq.invalid', now()),
  ('40000000-0000-4000-8000-000000000072', 'qa-v1-fast-track-tech@nailiq.invalid', now());

INSERT INTO public.service_categories (slug, name_en, name_vi)
VALUES ('other', 'Other', 'Khác')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.salons (
  id, slug, name, phone, profile_complete, timezone, opening_hours,
  booking_lead_minutes, resources_enabled
) VALUES (
  '10000000-0000-4000-8000-000000000071',
  'qa-v1-fast-track-capability',
  'QA V1 Fast Track Capability',
  '16045550071',
  true,
  'UTC',
  '{
    "mon":{"open":"00:00","close":"23:59","closed":false},
    "tue":{"open":"00:00","close":"23:59","closed":false},
    "wed":{"open":"00:00","close":"23:59","closed":false},
    "thu":{"open":"00:00","close":"23:59","closed":false},
    "fri":{"open":"00:00","close":"23:59","closed":false},
    "sat":{"open":"00:00","close":"23:59","closed":false},
    "sun":{"open":"00:00","close":"23:59","closed":false}
  }'::jsonb,
  0,
  false
);

INSERT INTO public.staff (id, salon_id, name, job_role) VALUES
  ('20000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000071', 'QA One', 'nail_tech'),
  ('20000000-0000-4000-8000-000000000072', '10000000-0000-4000-8000-000000000071', 'QA Two', 'nail_tech');

INSERT INTO public.services (
  id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
  is_addon, addon_timing
) VALUES
  ('30000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000071', 'QA Main', 5000, 30, 0, false, 'sequential'),
  ('30000000-0000-4000-8000-000000000072', '10000000-0000-4000-8000-000000000071', 'QA Add-on', 1200, 10, 0, true, 'sequential');

INSERT INTO public.salon_members (salon_id, user_id, role) VALUES
  ('10000000-0000-4000-8000-000000000071', '40000000-0000-4000-8000-000000000071', 'owner'),
  ('10000000-0000-4000-8000-000000000071', '40000000-0000-4000-8000-000000000072', 'nail_tech');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000071', true);
DO $direct_partial_write$
BEGIN
  BEGIN
    INSERT INTO public.staff_services (staff_id, service_id) VALUES (
      '20000000-0000-4000-8000-000000000071',
      '30000000-0000-4000-8000-000000000071'
    );
    RAISE EXCEPTION 'direct partial legacy capability write unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
END
$direct_partial_write$;
RESET ROLE;

-- A regular salon member cannot invoke the mutation even though the function
-- itself is exposed to authenticated callers.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000072', true);
DO $non_manager_denied$
BEGIN
  BEGIN
    PERFORM public.set_staff_service_capabilities(
      '10000000-0000-4000-8000-000000000071',
      '20000000-0000-4000-8000-000000000071',
      ARRAY['30000000-0000-4000-8000-000000000071'::uuid]
    );
    RAISE EXCEPTION 'non-manager capability mutation unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$non_manager_denied$;

-- Prove the exact Data API role used by the server action, not only the
-- service-role maintenance escape hatch.
SELECT set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000071', true);
SELECT public.set_staff_service_capabilities(
  '10000000-0000-4000-8000-000000000071',
  '20000000-0000-4000-8000-000000000071',
  ARRAY['30000000-0000-4000-8000-000000000071'::uuid]
);
RESET ROLE;

DO $transition_proof$
DECLARE
  v_selected integer;
  v_colleague integer;
BEGIN
  IF (SELECT staff_capability_mode FROM public.salons
      WHERE id = '10000000-0000-4000-8000-000000000071') <> 'whitelist' THEN
    RAISE EXCEPTION 'legacy transition did not persist whitelist mode';
  END IF;

  SELECT count(*) INTO v_selected
  FROM public.staff_services
  WHERE staff_id = '20000000-0000-4000-8000-000000000071';
  SELECT count(*) INTO v_colleague
  FROM public.staff_services
  WHERE staff_id = '20000000-0000-4000-8000-000000000072';

  IF v_selected <> 1 OR v_colleague <> 2 THEN
    RAISE EXCEPTION 'atomic legacy seed drifted: selected=% colleague=%',
      v_selected, v_colleague;
  END IF;
END
$transition_proof$;

-- Even an owner cannot reopen legacy mode or delete the salon's final active
-- capability row outside the atomic RPC.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000071', true);
DO $direct_reopen_denied$
BEGIN
  BEGIN
    UPDATE public.salons
    SET staff_capability_mode = 'legacy_all'
    WHERE id = '10000000-0000-4000-8000-000000000071';
    RAISE EXCEPTION 'owner reopened legacy capability mode';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  BEGIN
    DELETE FROM public.staff_services
    WHERE staff_id IN (
      '20000000-0000-4000-8000-000000000071',
      '20000000-0000-4000-8000-000000000072'
    );
    RAISE EXCEPTION 'owner deleted the global capability whitelist';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;
END
$direct_reopen_denied$;
RESET ROLE;

-- Emptying one staff remains fail closed because the colleague still owns a
-- durable row, so booking readers do not fall back to legacy all-capable.
SET LOCAL ROLE service_role;
SELECT public.set_staff_service_capabilities(
  '10000000-0000-4000-8000-000000000071',
  '20000000-0000-4000-8000-000000000071',
  ARRAY[]::uuid[]
);
RESET ROLE;

SET LOCAL ROLE service_role;
DO $global_empty_rollback$
DECLARE
  v_before integer;
  v_after integer;
BEGIN
  SELECT count(*) INTO v_before
  FROM public.staff_services
  WHERE staff_id = '20000000-0000-4000-8000-000000000072';

  BEGIN
    PERFORM public.set_staff_service_capabilities(
      '10000000-0000-4000-8000-000000000071',
      '20000000-0000-4000-8000-000000000072',
      ARRAY[]::uuid[]
    );
    RAISE EXCEPTION 'global empty whitelist unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;

  SELECT count(*) INTO v_after
  FROM public.staff_services
  WHERE staff_id = '20000000-0000-4000-8000-000000000072';
  IF v_before <> 2 OR v_after <> v_before THEN
    RAISE EXCEPTION 'failed empty transition did not roll back: before=% after=%',
      v_before, v_after;
  END IF;
END
$global_empty_rollback$;
RESET ROLE;

ROLLBACK;
