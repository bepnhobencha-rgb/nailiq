-- Correct the shared individual evaluator, without changing its API or grants.
-- Wall minutes enumerate customer starts; actual UTC occupancy is authoritative
-- for customer completion at closing and full prep/buffer overlap checks.
-- Preserve canonical public policy: cleanup may follow salon close, but a
-- staff shift or another reservation must still fit the full occupancy.
-- No data rewrite, feature activation, provider work or migration history write.
-- Rollback: restore the preceding evaluator definition captured in QA metadata,
-- retaining its service_role-only ACL. Do not reverse committed domain records.
DO $capacity_time$
DECLARE v_target regprocedure; v_def text; v_patch jsonb; v_old text; v_new text; v_count integer;
BEGIN
  v_target:=pg_catalog.to_regprocedure('public.evaluate_individual_waitlist_capacity(uuid,uuid,uuid,date,text)');
  IF v_target IS NULL THEN RAISE EXCEPTION 'Waitlist capacity time target missing'; END IF;
  v_def:=pg_catalog.pg_get_functiondef(v_target);
  FOR v_patch IN SELECT value FROM pg_catalog.jsonb_array_elements(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object('count',1,'old',$old$  v_duration integer;
  v_buffer integer;$old$,'new',$new$  v_duration integer;
  v_prep integer;
  v_buffer integer;$new$),
    pg_catalog.jsonb_build_object('count',1,'old',$old$  v_candidate_start timestamptz;$old$,'new',$new$  v_open_utc timestamptz;
  v_close_utc timestamptz;
  v_candidate_wall timestamp;
  v_occupied_start timestamptz;
  v_candidate_start timestamptz;$new$),
    pg_catalog.jsonb_build_object('count',1,'old',$old$      svc.duration_minutes,
      coalesce(svc.buffer_minutes, 0),$old$,'new',$new$      svc.duration_minutes,
      coalesce(svc.prep_minutes, 0),
      coalesce(svc.buffer_minutes, 0),$new$),
    pg_catalog.jsonb_build_object('count',1,'old',$old$    INTO v_duration, v_buffer, v_resource_mode, v_required_kinds$old$,'new',$new$    INTO v_duration, v_prep, v_buffer, v_resource_mode, v_required_kinds$new$),
    pg_catalog.jsonb_build_object('count',1,'old',$old$v_duration <= 0 OR v_buffer < 0 THEN$old$,'new',$new$v_duration <= 0 OR v_prep < 0 OR v_buffer < 0 THEN$new$),
    pg_catalog.jsonb_build_object('count',1,'old',$old$    IF v_day IS NULL
       OR coalesce((v_day ->> 'closed')::boolean, false)
       OR coalesce(v_day ->> 'open', '') !~ '^[0-2][0-9]:[0-5][0-9]$'
       OR coalesce(v_day ->> 'close', '') !~ '^[0-2][0-9]:[0-5][0-9]$' THEN
      RETURN QUERY SELECT 'slot_unavailable', NULL::text, 0, 0, 0, 0;
      RETURN;
    END IF;$old$,'new',$new$    -- Unknown or malformed configuration is not proof that the day is full.
    IF pg_catalog.jsonb_typeof(v_day) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(v_day -> 'closed') IS DISTINCT FROM 'boolean' THEN
      RETURN QUERY SELECT 'availability_unverified', NULL::text, 0, 0, 0, 0;
      RETURN;
    END IF;
    IF (v_day ->> 'closed')::boolean THEN
      RETURN QUERY SELECT 'slot_unavailable', NULL::text, 0, 0, 0, 0;
      RETURN;
    END IF;
    IF coalesce(v_day ->> 'open', '') !~ '^[0-2][0-9]:[0-5][0-9]$'
       OR coalesce(v_day ->> 'close', '') !~ '^[0-2][0-9]:[0-5][0-9]$' THEN
      RETURN QUERY SELECT 'availability_unverified', NULL::text, 0, 0, 0, 0;
      RETURN;
    END IF;$new$),
    pg_catalog.jsonb_build_object('count',1,'old',$old$    IF v_requested_label IS NOT NULL THEN
      v_match :=$old$,'new',$new$    v_open_utc := (p_booking_date::timestamp + pg_catalog.make_interval(mins => v_open_min)) AT TIME ZONE v_timezone;
    v_close_utc := (p_booking_date::timestamp + pg_catalog.make_interval(mins => v_close_min)) AT TIME ZONE v_timezone;
    -- An invalid configured boundary is not proof of a full day. Do not
    -- normalize a nonexistent opening/closing wall minute into another hour.
    IF (v_open_utc AT TIME ZONE v_timezone) <> p_booking_date::timestamp + pg_catalog.make_interval(mins => v_open_min)
       OR (v_close_utc AT TIME ZONE v_timezone) <> p_booking_date::timestamp + pg_catalog.make_interval(mins => v_close_min)
       OR v_open_utc >= v_close_utc THEN
      RETURN QUERY SELECT 'availability_unverified', NULL::text, 0, 0, 0, 0;
      RETURN;
    END IF;

    IF v_requested_label IS NOT NULL THEN
      v_match :=$new$),
    pg_catalog.jsonb_build_object('count',1,'old',$old$          v_close_min - v_duration,$old$,'new',$new$          v_close_min - 1,$new$),
    pg_catalog.jsonb_build_object('count',1,'old',$old$SELECT b.end_time_utc AT TIME ZONE v_timezone AS local_end$old$,'new',$new$SELECT (b.end_time_utc + pg_catalog.make_interval(mins => v_prep)) AT TIME ZONE v_timezone AS local_end$new$),
    pg_catalog.jsonb_build_object('count',1,'old',$old$SELECT seg.occupied_end_utc AT TIME ZONE v_timezone AS local_end$old$,'new',$new$SELECT (seg.occupied_end_utc + pg_catalog.make_interval(mins => v_prep)) AT TIME ZONE v_timezone AS local_end$new$),
    pg_catalog.jsonb_build_object('count',1,'old',$old$        AND candidate.minute_value + v_duration <= v_close_min$old$,'new',$new$        AND candidate.minute_value < v_close_min$new$),
    pg_catalog.jsonb_build_object('count',1,'old',$old$      v_candidate_end := v_customer_end
        + pg_catalog.make_interval(mins => v_buffer);

      IF p_booking_date =$old$,'new',$new$      v_candidate_end := v_customer_end
        + pg_catalog.make_interval(mins => v_buffer);
      v_occupied_start := v_candidate_start - pg_catalog.make_interval(mins => v_prep);
      v_candidate_wall := p_booking_date::timestamp + pg_catalog.make_interval(mins => v_candidate_min);
      IF (v_candidate_start AT TIME ZONE v_timezone) <> v_candidate_wall THEN
        IF v_requested_label IS NOT NULL THEN
          RETURN QUERY SELECT 'availability_unverified', NULL::text, v_eligible_staff, v_eligible_resources, 0, 0;
          RETURN;
        END IF;
        CONTINUE;
      END IF;
      IF v_occupied_start < v_open_utc OR v_customer_end > v_close_utc THEN
        CONTINUE;
      END IF;

      IF p_booking_date =$new$),
    pg_catalog.jsonb_build_object('count',2,'old',$old$AND existing.end_time_utc > v_candidate_start$old$,'new',$new$AND existing.end_time_utc > v_occupied_start$new$),
    pg_catalog.jsonb_build_object('count',2,'old',$old$AND segment.occupied_end_utc > v_candidate_start$old$,'new',$new$AND segment.occupied_end_utc > v_occupied_start$new$),
    pg_catalog.jsonb_build_object('count',1,'old',$old$              AND shift.start_time::time <= (v_candidate_start AT TIME ZONE v_timezone)::time
              AND shift.end_time::time >= (v_candidate_end AT TIME ZONE v_timezone)::time$old$,'new',$new$              AND ((p_booking_date + shift.start_time::time) AT TIME ZONE v_timezone) <= v_occupied_start
              AND ((p_booking_date + shift.end_time::time) AT TIME ZONE v_timezone) >= v_candidate_end$new$),
    pg_catalog.jsonb_build_object('count',1,'old',$old$                AND (v_candidate_start AT TIME ZONE v_timezone)::time < shift.break_end_time
                AND (v_candidate_end AT TIME ZONE v_timezone)::time > shift.break_start_time$old$,'new',$new$                AND v_occupied_start < ((p_booking_date + shift.break_end_time) AT TIME ZONE v_timezone)
                AND v_candidate_end > ((p_booking_date + shift.break_start_time) AT TIME ZONE v_timezone)$new$)
  )) LOOP
    v_old:=v_patch->>'old'; v_new:=v_patch->>'new'; v_count:=(v_patch->>'count')::integer;
    IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old)<>v_count THEN
      RAISE EXCEPTION 'Waitlist capacity time anchor mismatch';
    END IF;
    v_def:=replace(v_def,v_old,v_new);
  END LOOP;
  EXECUTE v_def;
END;
$capacity_time$;
