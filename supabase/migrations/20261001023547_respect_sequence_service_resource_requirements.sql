-- Additive canonical resolver correction; no data rewrite or feature activation.
-- Parent and segments must receive the same service-compatible resource from
-- the quote, rather than relying on the parent's trigger to change it later.
-- Rollback: restore the preceding resolver definition captured before applying
-- this migration, retaining its signature, ACL and empty search_path. Never
-- drop consistency/exclusion guards or reverse committed bookings/receipts.
DO $patch$
DECLARE
  v_target regprocedure := to_regprocedure('public.resolve_booking_sequence_pricing_and_schedule(jsonb,boolean)');
  v_def text;
  v_patch jsonb;
  v_old text;
  v_new text;
  v_expected integer;
BEGIN
  IF v_target IS NULL THEN RAISE EXCEPTION 'Sequence resource resolver missing'; END IF;
  v_def:=pg_catalog.pg_get_functiondef(v_target);
  FOR v_patch IN SELECT value FROM pg_catalog.jsonb_array_elements(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object('count',1,'old',$old$  v_resources_enabled boolean;$old$,'new',$new$  v_resources_enabled boolean;
  v_salon_resources_enabled boolean;
  v_resource_mode text;
  v_required_resource_kinds text[];$new$),
    pg_catalog.jsonb_build_object('count',1,'old',$old$  IF p_lock_claims THEN
    PERFORM public.lock_booking_crm_phones(ARRAY[v_client_phone]);$old$,'new',$new$  v_salon_resources_enabled:=v_resources_enabled;
  IF p_lock_claims THEN
    PERFORM public.lock_booking_crm_phones(ARRAY[v_client_phone]);$new$),
    pg_catalog.jsonb_build_object('count',1,'old',$old$    SELECT s.duration_minutes, s.prep_minutes, s.name, s.category
    INTO v_service_duration, v_prep_minutes, v_service_name, v_service_category$old$,'new',$new$    SELECT s.duration_minutes, s.prep_minutes, s.name, s.category,
      s.resource_requirement_mode,s.required_resource_kinds
    INTO v_service_duration, v_prep_minutes, v_service_name, v_service_category,
      v_resource_mode,v_required_resource_kinds$new$),
    pg_catalog.jsonb_build_object('count',1,'old',$old$    v_resolved_timing_mode := 'sequential';$old$,'new',$new$    -- Reset for every line; a no-resource service must not disable later lines.
    v_resources_enabled:=v_salon_resources_enabled AND v_resource_mode<>'none';
    IF v_salon_resources_enabled AND v_resource_mode='none' THEN
      IF v_resource_id IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_resource');
      END IF;
      v_resource_id:=NULL;
    END IF;
    v_resolved_timing_mode := 'sequential';$new$),
    pg_catalog.jsonb_build_object('count',1,'old',$old$      WHERE r.salon_id = v_salon_id AND r.status = 'active' AND r.deleted_at IS NULL
        AND NOT EXISTS ($old$,'new',$new$      WHERE r.salon_id = v_salon_id AND r.status = 'active' AND r.deleted_at IS NULL
        AND (NOT v_salon_resources_enabled OR v_resource_mode<>'specific' OR r.kind=ANY(v_required_resource_kinds))
        AND NOT EXISTS ($new$),
    pg_catalog.jsonb_build_object('count',2,'old',$old$          AND r.status = 'active' AND r.deleted_at IS NULL
          AND NOT EXISTS ($old$,'new',$new$          AND r.status = 'active' AND r.deleted_at IS NULL
          AND (NOT v_salon_resources_enabled OR v_resource_mode<>'specific' OR r.kind=ANY(v_required_resource_kinds))
          AND NOT EXISTS ($new$),
    pg_catalog.jsonb_build_object('count',1,'old',$old$        AND r.status = 'active' AND r.deleted_at IS NULL
        AND r.same_guest_parallel_capacity >= 2$old$,'new',$new$        AND r.status = 'active' AND r.deleted_at IS NULL
        AND (NOT v_salon_resources_enabled OR v_resource_mode<>'specific' OR r.kind=ANY(v_required_resource_kinds))
        AND EXISTS (
          SELECT 1 FROM public.services previous_service
          WHERE previous_service.id=v_previous_service_id
            AND previous_service.salon_id=v_salon_id
            AND previous_service.deleted_at IS NULL
            AND previous_service.resource_requirement_mode<>'none'
            AND (previous_service.resource_requirement_mode<>'specific'
              OR r.kind=ANY(previous_service.required_resource_kinds))
        )
        AND r.same_guest_parallel_capacity >= 2$new$),
    pg_catalog.jsonb_build_object('count',1,'old',$old$        AND r.status = 'active' AND r.deleted_at IS NULL
    ) THEN$old$,'new',$new$        AND r.status = 'active' AND r.deleted_at IS NULL
        AND (NOT v_salon_resources_enabled OR v_resource_mode<>'specific' OR r.kind=ANY(v_required_resource_kinds))
    ) THEN$new$),
    pg_catalog.jsonb_build_object('count',1,'old',$old$        AND r.status = 'active' AND r.deleted_at IS NULL
      FOR UPDATE;$old$,'new',$new$        AND r.status = 'active' AND r.deleted_at IS NULL
        AND (NOT v_salon_resources_enabled OR v_resource_mode<>'specific' OR r.kind=ANY(v_required_resource_kinds))
      FOR UPDATE;$new$)
  )) LOOP
    v_old:=v_patch->>'old'; v_new:=v_patch->>'new';
    v_expected:=(v_patch->>'count')::integer;
    IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old)<>v_expected THEN
      RAISE EXCEPTION 'Sequence resource anchor mismatch';
    END IF;
    v_def:=replace(v_def,v_old,v_new);
  END LOOP;
  EXECUTE v_def;
END;
$patch$;
