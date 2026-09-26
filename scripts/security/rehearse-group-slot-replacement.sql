-- Disposable database only. Synthetic fixtures, transaction rolled back.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
CREATE FUNCTION pg_temp.assert_true(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'assertion failed: %',label; END IF; END; $$;
INSERT INTO public.salons(id,slug,name,phone,timezone,currency_code,profile_complete,noshow_protection_enabled,feature_flags)
VALUES('ee260925-0000-4000-8000-000000000001','e2e-group-slot-replacement','E2E Group Recovery','16045550100','America/Vancouver','CAD',true,false,'{"group_slot_recovery_v1":true}');
INSERT INTO public.service_categories(slug,name_en,name_vi) VALUES('group-recovery-test','Synthetic','Synthetic') ON CONFLICT DO NOTHING;
INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
VALUES('ee260925-0000-4000-8000-000000000002','ee260925-0000-4000-8000-000000000001','Synthetic Service',5000,30,'group-recovery-test');
INSERT INTO public.staff(id,salon_id,name,status)
VALUES('ee260925-0000-4000-8000-000000000003','ee260925-0000-4000-8000-000000000001','Synthetic Staff','active');
INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,attendance_status,price_cents,group_id,group_size,is_party_member,is_group_organizer)
SELECT ('ee260925-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'ee260925-0000-4000-8000-000000000001','ee260925-0000-4000-8000-000000000002','ee260925-0000-4000-8000-000000000003',
 'Synthetic Original', '1604555'||lpad(i::text,4,'0'),now()+interval '3 days'+i*interval '1 hour',now()+interval '3 days'+i*interval '1 hour'+interval '30 minutes','confirmed','confirmed',5000,
 'ee260925-0000-4000-8000-000000000099',8,true,i=10 FROM generate_series(10,17) i;
CREATE TEMP TABLE recovery_test AS SELECT i,('ee260925-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid booking_id,
 (public.mint_booking_management_capability('ee260925-0000-4000-8000-000000000001',('ee260925-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'cancel',now()+interval '2 hours')->>'token_id')::uuid cap
 FROM generate_series(10,17) i;
SELECT pg_temp.assert_true((public.inspect_group_slot_recovery(cap)->>'ok')='false','organizer denied') FROM recovery_test WHERE i=10;
SELECT pg_temp.assert_true((public.start_group_slot_replacement(cap,'ee260925-0000-4000-8000-000000000101',repeat('a',64))->>'ok')='true','create invite') FROM recovery_test WHERE i=11;
SELECT pg_temp.assert_true((public.start_group_slot_replacement(cap,'ee260925-0000-4000-8000-000000000101',repeat('a',64))->>'idempotent')='true','start replay') FROM recovery_test WHERE i=11;
SELECT pg_temp.assert_true((SELECT status='confirmed' FROM public.bookings WHERE id=booking_id),'reserved during invite') FROM recovery_test WHERE i=11;
SELECT pg_temp.assert_true((public.inspect_group_slot_replacement(repeat('a',64))->>'state')='available','preview available');
SELECT pg_temp.assert_true(NOT(public.inspect_group_slot_replacement(repeat('a',64)) ? 'client_name'),'no original identity');
SELECT pg_temp.assert_true((public.accept_group_slot_replacement(repeat('a',64),'ee260925-0000-4000-8000-000000000102','Synthetic Replacement','16045550999',false)->>'ok')='false','consent required');
SELECT pg_temp.assert_true((public.accept_group_slot_replacement(repeat('a',64),'ee260925-0000-4000-8000-000000000102','Synthetic Replacement','16045550011',true)->>'ok')='false','same identity denied');
SELECT pg_temp.assert_true((public.accept_group_slot_replacement(repeat('a',64),'ee260925-0000-4000-8000-000000000102','Synthetic Replacement','16045550999',true)->>'ok')='true','accept');
SELECT pg_temp.assert_true((public.accept_group_slot_replacement(repeat('a',64),'ee260925-0000-4000-8000-000000000102','Synthetic Replacement','16045550999',true)->>'idempotent')='true','accept replay');
SELECT pg_temp.assert_true((public.accept_group_slot_replacement(repeat('a',64),'ee260925-0000-4000-8000-000000000102','Changed Person','16045550888',true)->>'code')='already_accepted','payload mismatch denied');
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM public.group_slot_replacements WHERE salon_id='ee260925-0000-4000-8000-000000000001' AND status='accepted'),'one accepted');
SELECT pg_temp.assert_true(b.status='cancelled' AND b.client_name='Synthetic Original' AND b.client_phone='16045550011','original terminal identity unchanged') FROM public.bookings b JOIN recovery_test t ON t.booking_id=b.id WHERE t.i=11;
SELECT pg_temp.assert_true(b.status='confirmed' AND b.client_name='Synthetic Replacement' AND b.noshow_card_id IS NULL AND b.noshow_consent_at IS NULL AND b.client_email IS NULL AND b.sms_consent_at IS NULL,'fresh identity no copied authority') FROM public.bookings b JOIN public.group_slot_replacements r ON r.replacement_booking_id=b.id WHERE r.salon_id='ee260925-0000-4000-8000-000000000001' AND r.status='accepted';
SELECT pg_temp.assert_true((SELECT count(*)=0 FROM public.owner_booking_notification_outbox WHERE booking_id IN (SELECT original_booking_id FROM public.group_slot_replacements UNION SELECT replacement_booking_id FROM public.group_slot_replacements)),'no owner dispatch');
SELECT pg_temp.assert_true((SELECT count(*)=0 FROM public.booking_payment_operations WHERE salon_id='ee260925-0000-4000-8000-000000000001'),'no payment');
SELECT pg_temp.assert_true((public.booking_management_current_group_material('ee260925-0000-4000-8000-000000000001','ee260925-0000-4000-8000-000000000099')->>'member_count')::integer=8,'replacement does not inflate member count');
SELECT pg_temp.assert_true((public.update_party_booking_contact(booking_id,'ee260925-0000-4000-8000-000000000001','Hijacked','16045550888')->>'success')='false','old party claim cannot rewrite accepted original') FROM recovery_test WHERE i=11;
SELECT (public.mint_booking_management_capability('ee260925-0000-4000-8000-000000000001',replacement_booking_id,'cancel',now()+interval '2 hours')->>'token_id') AS replacement_cancel_token FROM public.group_slot_replacements WHERE original_booking_id='ee260925-0000-4000-8000-000000000011' \gset
SELECT pg_temp.assert_true((public.start_group_slot_replacement(:'replacement_cancel_token'::uuid,'ee260925-0000-4000-8000-000000000117',repeat('3',64))->>'code')='contact_salon','replacement chain denied');
SAVEPOINT group_move;
SELECT (public.mint_booking_management_capability('ee260925-0000-4000-8000-000000000001','ee260925-0000-4000-8000-000000000010','group_reschedule',now()+interval '2 hours')->>'token_id') AS group_move_token \gset
SELECT jsonb_agg(jsonb_build_object('booking_id',m->>'booking_id','start_time_utc',(m->>'start_time_utc')::timestamptz+interval '10 days','end_time_utc',(m->>'end_time_utc')::timestamptz+interval '10 days')) AS move_slots
FROM jsonb_array_elements(public.booking_management_current_group_material('ee260925-0000-4000-8000-000000000001','ee260925-0000-4000-8000-000000000099')->'members') m \gset
SELECT pg_temp.assert_true((public.reschedule_group_booking_with_management_capability(:'group_move_token'::uuid,'ee260925-0000-4000-8000-000000000116',:'move_slots'::jsonb)->>'ok')='true','whole group reschedule works after replacement');
ROLLBACK TO group_move;
SAVEPOINT whole_party;
SELECT (public.mint_booking_management_capability('ee260925-0000-4000-8000-000000000001','ee260925-0000-4000-8000-000000000010','group_cancel',now()+interval '2 hours')->>'token_id') AS group_cancel_token \gset
SELECT pg_temp.assert_true((public.cancel_group_booking_with_management_capability(:'group_cancel_token'::uuid,'ee260925-0000-4000-8000-000000000115')->>'ok')='true','whole group cancel works after replacement');
ROLLBACK TO whole_party;
-- Expiry, current-card policy, revocation, stale and terminal booking safety.
SELECT public.start_group_slot_replacement(cap,'ee260925-0000-4000-8000-000000000103',repeat('b',64)) FROM recovery_test WHERE i=12;
UPDATE public.group_slot_replacements SET expires_at=now()-interval '1 second' WHERE token_hash=repeat('b',64);
SELECT pg_temp.assert_true((public.accept_group_slot_replacement(repeat('b',64),'ee260925-0000-4000-8000-000000000104','Expired Guest','16045550888',true)->>'ok')='false','expired denied');
UPDATE public.bookings SET noshow_card_required=true WHERE id=(SELECT booking_id FROM recovery_test WHERE i=13);
SELECT pg_temp.assert_true((public.start_group_slot_replacement(cap,'ee260925-0000-4000-8000-000000000105',repeat('c',64))->>'code')='card_protection_required','required card cannot bypass') FROM recovery_test WHERE i=13;
SELECT public.start_group_slot_replacement(cap,'ee260925-0000-4000-8000-000000000106',repeat('d',64)) FROM recovery_test WHERE i=14;
SELECT public.revoke_group_slot_replacement(cap,'ee260925-0000-4000-8000-000000000107') FROM recovery_test WHERE i=14;
SELECT pg_temp.assert_true((public.accept_group_slot_replacement(repeat('d',64),'ee260925-0000-4000-8000-000000000108','Revoked Guest','16045550888',true)->>'ok')='false','revoked denied');
SELECT public.start_group_slot_replacement(cap,'ee260925-0000-4000-8000-000000000114',repeat('2',64)) FROM recovery_test WHERE i=14;
SELECT public.revoke_group_slot_replacement(cap,'ee260925-0000-4000-8000-000000000107') FROM recovery_test WHERE i=14;
SELECT pg_temp.assert_true((public.inspect_group_slot_replacement(repeat('2',64))->>'state')='available','revoke replay cannot revoke new invitation');
SELECT public.start_group_slot_replacement(cap,'ee260925-0000-4000-8000-000000000109',repeat('e',64)) FROM recovery_test WHERE i=15;
UPDATE public.bookings SET price_cents=6000 WHERE id=(SELECT booking_id FROM recovery_test WHERE i=15);
SELECT pg_temp.assert_true((public.accept_group_slot_replacement(repeat('e',64),'ee260925-0000-4000-8000-000000000110','Stale Guest','16045550888',true)->>'code')='slot_changed','price change denied');
SELECT public.start_group_slot_replacement(cap,'ee260925-0000-4000-8000-000000000111',repeat('f',64)) FROM recovery_test WHERE i=16;
UPDATE public.bookings SET status='cancelled' WHERE id=(SELECT booking_id FROM recovery_test WHERE i=16);
SELECT pg_temp.assert_true((public.accept_group_slot_replacement(repeat('f',64),'ee260925-0000-4000-8000-000000000112','Terminal Guest','16045550888',true)->>'ok')='false','terminal cannot resurrect');
UPDATE public.salons SET feature_flags='{}' WHERE id='ee260925-0000-4000-8000-000000000001';
SELECT pg_temp.assert_true((public.start_group_slot_replacement(cap,'ee260925-0000-4000-8000-000000000113',repeat('1',64))->>'ok')='false','gate off') FROM recovery_test WHERE i=17;
SELECT pg_temp.assert_true(NOT has_function_privilege('anon','public.accept_group_slot_replacement(text,uuid,text,text,boolean)','execute') AND NOT has_function_privilege('authenticated','public.start_group_slot_replacement(uuid,uuid,text)','execute'),'browser execution denied');
SELECT pg_temp.assert_true(NOT has_table_privilege('anon','public.group_slot_replacements','SELECT') AND NOT has_table_privilege('authenticated','public.group_slot_replacements','SELECT'),'browser ledger denied');
SELECT 'PASS: atomic identity replacement, replay, consent, expiry, stale, terminal, gates and ACL';
ROLLBACK;
