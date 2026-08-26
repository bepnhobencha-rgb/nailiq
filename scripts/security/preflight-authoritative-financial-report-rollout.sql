\set ON_ERROR_STOP on

DO $preflight$
DECLARE
  v_rows bigint;
  v_table_bytes bigint;
  v_index_bytes bigint;
BEGIN
  SELECT coalesce(c.reltuples,0)::bigint,
    pg_total_relation_size(c.oid),pg_indexes_size(c.oid)
  INTO v_rows,v_table_bytes,v_index_bytes
  FROM pg_class c WHERE c.oid='public.booking_payment_operations'::regclass;
  RAISE NOTICE 'booking_payment_operations estimated_rows=% table_bytes=% index_bytes=%',
    v_rows,v_table_bytes,v_index_bytes;
  IF v_rows>100000 OR v_table_bytes>1073741824 OR v_index_bytes>1073741824 THEN
    RAISE EXCEPTION 'payment ledger exceeds reviewed index-rebuild budget; use a separately approved concurrent rollout';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.booking_payment_operations
    WHERE operation_kind='deposit_refund' AND booking_id IS NULL
      AND parent_operation_id IS NOT NULL
      AND status IN ('sending','pending_provider','reconciling','unknown','succeeded')
    GROUP BY parent_operation_id HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'duplicate active unbound compensation rows block safe unique index'; END IF;
  IF EXISTS(
    SELECT 1 FROM public.salons
    WHERE currency_code IS NULL OR upper(trim(currency_code))!~'^[A-Z]{3}$'
  ) THEN RAISE EXCEPTION 'invalid salon currency blocks single-currency report rollout'; END IF;
END;
$preflight$;

SELECT 'authoritative financial report preflight passed' AS result;
