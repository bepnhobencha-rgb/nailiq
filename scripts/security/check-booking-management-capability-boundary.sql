\set ON_ERROR_STOP on

DO $boundary$
DECLARE v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM (VALUES
    ('booking_management_action_state'),('booking_management_group_state'),
    ('booking_management_capabilities'),('booking_management_action_receipts'),
    ('booking_card_management_operations'),('booking_card_save_operations'),('waitlist_claim_action_state'),
    ('waitlist_claim_capabilities'),('waitlist_claim_action_receipts'),
    ('waitlist_offer_delivery_outbox'),('waitlist_offer_promotion_receipts')
  ) t(name)
  WHERE has_table_privilege('anon','public.'||name,'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated','public.'||name,'SELECT,INSERT,UPDATE,DELETE');
  IF v_count<>0 THEN
    RAISE EXCEPTION 'direct capability table exposure';
  END IF;
  SELECT count(*) INTO v_count FROM (VALUES
    ('mint_booking_management_capability(uuid,uuid,text,timestamp with time zone)'),
    ('exchange_public_booking_card_management_capability(uuid,uuid,uuid,text)'),
    ('booking_management_cancel_preview(uuid,uuid)'),
    ('inspect_booking_management_capability(uuid,text)'),
    ('confirm_booking_with_management_capability(uuid,uuid)'),
    ('reschedule_booking_with_management_capability(uuid,uuid,timestamp with time zone,timestamp with time zone)'),
    ('cancel_booking_with_management_capability(uuid,uuid)'),
    ('reschedule_group_booking_with_management_capability(uuid,uuid,jsonb)'),
    ('cancel_group_booking_with_management_capability(uuid,uuid)'),
    ('claim_booking_card_management_operation(uuid,uuid,text)'),
    ('complete_booking_card_management_operation(uuid,uuid,text,text,text)'),
    ('reconcile_stale_booking_card_management_operations(integer)'),
    ('claim_booking_card_save_operation(uuid,uuid,text,text,text)'),
    ('prepare_booking_card_save_dispatch(uuid,uuid,timestamp with time zone,jsonb)'),
    ('complete_booking_card_save_operation(uuid,uuid,text,text,text,text,text,text,timestamp with time zone,jsonb,text)'),
    ('reconcile_stale_booking_card_save_operations(integer)'),
    ('complete_booking_card_save_reconciliation(uuid,uuid,text,text,text,text,text)'),
    ('mint_waitlist_claim_capability(uuid,uuid,timestamp with time zone)'),
    ('promote_waitlist_for_freed_slot(uuid,uuid,date,uuid,timestamp with time zone,timestamp with time zone,integer)'),
    ('promote_waitlist_for_booking(uuid)'),
    ('promote_waitlist_entry(uuid,uuid,integer)'),
    ('advance_waitlist_offer_capabilities(integer)'),
    ('cancel_booking_by_id_with_waitlist_offer(uuid)'),
    ('inspect_waitlist_claim_capability(uuid)'),
    ('claim_waitlist_with_management_capability(uuid,uuid)'),
    ('load_waitlist_offer_delivery_material(uuid,uuid,bigint,text,uuid)'),
    ('claim_waitlist_offer_delivery(uuid,uuid,bigint,text,uuid,text,text,text)'),
    ('complete_waitlist_offer_delivery(uuid,uuid,text,text,text)'),
    ('cancel_booking_by_id(uuid)'),('notify_waitlist_for_no_show(uuid)'),
    ('claim_waitlist_slot(uuid)')
  ) s(signature)
  WHERE has_function_privilege('anon','public.'||signature,'EXECUTE')
     OR has_function_privilege('authenticated','public.'||signature,'EXECUTE');
  IF v_count<>0 THEN RAISE EXCEPTION 'anon/auth capability execute exposure: %',v_count; END IF;
  SELECT count(*) INTO v_count FROM (VALUES
    ('mint_booking_management_capability(uuid,uuid,text,timestamp with time zone)'),
    ('exchange_public_booking_card_management_capability(uuid,uuid,uuid,text)'),
    ('booking_management_cancel_preview(uuid,uuid)'),
    ('inspect_booking_management_capability(uuid,text)'),
    ('confirm_booking_with_management_capability(uuid,uuid)'),
    ('reschedule_booking_with_management_capability(uuid,uuid,timestamp with time zone,timestamp with time zone)'),
    ('cancel_booking_with_management_capability(uuid,uuid)'),
    ('claim_booking_card_management_operation(uuid,uuid,text)'),
    ('complete_booking_card_management_operation(uuid,uuid,text,text,text)'),
    ('reconcile_stale_booking_card_management_operations(integer)'),
    ('claim_booking_card_save_operation(uuid,uuid,text,text,text)'),
    ('prepare_booking_card_save_dispatch(uuid,uuid,timestamp with time zone,jsonb)'),
    ('complete_booking_card_save_operation(uuid,uuid,text,text,text,text,text,text,timestamp with time zone,jsonb,text)'),
    ('reconcile_stale_booking_card_save_operations(integer)'),
    ('complete_booking_card_save_reconciliation(uuid,uuid,text,text,text,text,text)'),
    ('mint_waitlist_claim_capability(uuid,uuid,timestamp with time zone)'),
    ('promote_waitlist_for_booking(uuid)'),('promote_waitlist_entry(uuid,uuid,integer)'),
    ('advance_waitlist_offer_capabilities(integer)'),('cancel_booking_by_id_with_waitlist_offer(uuid)'),
    ('inspect_waitlist_claim_capability(uuid)'),('claim_waitlist_with_management_capability(uuid,uuid)'),
    ('load_waitlist_offer_delivery_material(uuid,uuid,bigint,text,uuid)'),
    ('claim_waitlist_offer_delivery(uuid,uuid,bigint,text,uuid,text,text,text)'),
    ('complete_waitlist_offer_delivery(uuid,uuid,text,text,text)'),
    ('cancel_booking_by_id(uuid)'),('notify_waitlist_for_no_show(uuid)'),('claim_waitlist_slot(uuid)')
  ) s(signature) WHERE NOT has_function_privilege('service_role','public.'||signature,'EXECUTE');
  IF v_count<>0 THEN
    RAISE EXCEPTION 'service-role rollout compatibility missing';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND (p.proname LIKE '%management_capability%'
      OR p.proname LIKE '%waitlist%capabilit%'
      OR p.proname IN ('booking_management_cancel_preview','claim_booking_card_management_operation',
        'complete_booking_card_management_operation','reconcile_stale_booking_card_management_operations',
        'claim_booking_card_save_operation','complete_booking_card_save_operation',
        'prepare_booking_card_save_dispatch','reconcile_stale_booking_card_save_operations',
        'complete_booking_card_save_reconciliation','promote_waitlist_for_freed_slot',
        'promote_waitlist_for_booking','promote_waitlist_entry','cancel_booking_by_id_with_waitlist_offer',
        'ensure_waitlist_offer_delivery_outbox','load_waitlist_offer_delivery_material','claim_waitlist_offer_delivery',
        'complete_waitlist_offer_delivery'))
      AND (NOT p.prosecdef OR array_to_string(p.proconfig,',')<>'search_path=""')) THEN
    RAISE EXCEPTION 'SECURITY DEFINER/search_path contract mismatch';
  END IF;
END;
$boundary$;
