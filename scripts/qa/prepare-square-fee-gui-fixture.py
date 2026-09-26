"""Prepare (never execute) a Square Sandbox receipt-backed hosted-QA GUI fixture.

Default --plan is offline. --verify-and-prepare performs allowlisted read-only
provider/QA requests after explicit opt-in, then writes private SQL + journal.
No customer/card/payment POST; no DB mutation; no dispatch flag changes.
The SQL imports an existing verified Sandbox card receipt and synthetic consent;
it does not claim that the application's save-card flow was exercised.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import sys
import urllib.parse
import urllib.request
import urllib.error

ROOT = pathlib.Path(__file__).resolve().parents[2]
PROJECT = "osdqutwunokiielbairj"
QA_ORIGIN = f"https://{PROJECT}.supabase.co"
SQUARE_ORIGIN = "https://connect.squareupsandbox.com"
SLUG = "card-truth-preview-20260911"
NAME = "Synthetic Card Preview QA"
REFERENCE = "df910d2b-656b-4209-ae78-8b8a7aa13e1a"
BUILD = "bd7fda5c"
FIXTURE = "E2E Fee Sandbox GUI 20260925"
PREFIX = "fd202609"
BRANDS = {"VISA", "MASTERCARD", "AMERICAN_EXPRESS", "DISCOVER", "DISCOVER_DINERS", "DINERS_CLUB", "JCB", "UNIONPAY", "CHINA_UNIONPAY", "EFTPOS", "INTERAC", "OTHER_BRAND"}


def stop(code):
    raise RuntimeError(code)


def private_json(filename):
    p = pathlib.Path(filename).resolve(strict=True)
    if p.is_relative_to(ROOT) or p.stat().st_mode & 0o077:
        stop("external_private_credentials_required")
    return json.loads(p.read_text())


def write_private(p, body):
    with open(p, "x", opener=lambda name, flags: os.open(name, flags, 0o600)) as f:
        f.write(body)
        f.flush()
        os.fsync(f.fileno())


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9:_-]{1,255}", value):
        stop("invalid_provider_identifier")
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        stop("redirect_denied")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--verify-and-prepare", action="store_true")
    ap.add_argument("--square-credentials")
    ap.add_argument("--qa-credentials", help="external private JSON: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY")
    ap.add_argument("--output-directory")
    args = ap.parse_args()
    plan = {"targetCommit": BUILD, "project": PROJECT, "salonSlug": SLUG,
            "reference": REFERENCE, "existingCustomerAndCardOnly": True,
            "scenarios": ["no_show", "late_cancel", "group_cancel"], "amountCentsEach": 100,
            "currency": "CAD", "providerMutations": 0, "databaseMutations": 0,
            "dispatchFlagsChanged": False, "receiptOrigin": "existing_card_read",
            "declineGui": "NOT_PREPARED: magic Sandbox decline ID has no real saved-card receipt",
            "replay": "Use the same GUI fee review/request; never seed a second review to repeat it"}
    if not args.verify_and_prepare:
        print(json.dumps({"status": "OFFLINE_PLAN_ONLY", **plan}, indent=2))
        return
    if args.plan or os.environ.get("NAILIQ_FEE_GUI_READONLY_APPROVED") != "1":
        stop("read_only_preparation_opt_in_required")
    if any(os.environ.get(k) != "1" for k in ("DISABLE_OUTBOUND_SMS", "DISABLE_OUTBOUND_EMAIL", "DISABLE_OUTBOUND_CALLS")):
        stop("outbound_suppression_required")
    if not all((args.square_credentials, args.qa_credentials, args.output_directory)):
        stop("external_paths_required")
    output = pathlib.Path(args.output_directory).resolve(strict=True)
    if not output.is_dir() or output.is_relative_to(ROOT):
        stop("external_output_directory_required")
    square = private_json(args.square_credentials)
    qa = private_json(args.qa_credentials)
    if qa.get("NEXT_PUBLIC_SUPABASE_URL", "").rstrip("/") != QA_ORIGIN:
        stop("qa_project_mismatch")
    token = square["NAILIQ_QA_SQUARE_SANDBOX_ACCESS_TOKEN"]
    app = identifier(square["NAILIQ_QA_SQUARE_SANDBOX_APPLICATION_ID"])
    merchant = identifier(square["NAILIQ_QA_SQUARE_SANDBOX_MERCHANT_ID"])
    location = identifier(square["NAILIQ_QA_SQUARE_SANDBOX_LOCATION_ID"])
    if not app.startswith("sandbox-sq0idb-"):
        stop("sandbox_application_required")
    journal_path = output / "fee-gui-readonly-preparation.journal.jsonl"
    journal = open(journal_path, "x", opener=lambda name, flags: os.open(name, flags, 0o600))
    reads = 0
    def read(origin, path, method="GET"):
        nonlocal reads
        parsed = urllib.parse.urlsplit(path)
        if parsed.scheme or parsed.netloc or not path.startswith("/"):
            stop("relative_path_required")
        if origin == SQUARE_ORIGIN:
            allowed = parsed.path in ("/oauth2/token/status", "/v2/locations", "/v2/cards") or re.fullmatch(r"/v2/customers/[A-Za-z0-9_-]+", parsed.path)
            if not allowed or (method != "GET" and not (method == "POST" and parsed.path == "/oauth2/token/status")):
                stop("provider_mutation_denied")
            headers = {"Authorization": "Bearer " + token, "Square-Version": "2024-12-18"}
        elif origin == QA_ORIGIN and method == "GET" and parsed.path in ("/rest/v1/salons", "/rest/v1/square_integrations"):
            key = qa["SUPABASE_SERVICE_ROLE_KEY"]
            headers = {"apikey": key, "Authorization": "Bearer " + key}
        else:
            stop("network_boundary_denied")
        reads += 1
        if reads > 55:
            stop("read_budget_exhausted")
        journal.write(json.dumps({"at": dt.datetime.now(dt.timezone.utc).isoformat(), "method": method,
                                  "origin": origin, "route": "/v2/customers/:id" if parsed.path.startswith("/v2/customers/") else parsed.path}) + "\n")
        journal.flush()
        os.fsync(journal.fileno())
        req = urllib.request.Request(origin + path, headers=headers, method=method)
        try:
            with urllib.request.build_opener(NoRedirect).open(req, timeout=15) as response:
                value = json.load(response)
        except urllib.error.HTTPError as exc:
            journal.write(json.dumps({"outcome": "http_error", "httpStatus": exc.code}) + "\n")
            journal.flush()
            stop("read_http_error")
        except urllib.error.URLError as exc:
            journal.write(json.dumps({"outcome": "transport_error", "errorType": type(exc.reason).__name__}) + "\n")
            journal.flush()
            stop("read_transport_error")
        if isinstance(value, dict) and value.get("errors"):
            stop("provider_read_rejected")
        return value
    try:
        identity = read(SQUARE_ORIGIN, "/oauth2/token/status", "POST")
        if identity.get("client_id") != app or identity.get("merchant_id") != merchant:
            stop("sandbox_identity_mismatch")
        locations = read(SQUARE_ORIGIN, "/v2/locations")
        if not any(r.get("id") == location and r.get("merchant_id") == merchant and r.get("currency") == "CAD" and r.get("status") == "ACTIVE" for r in locations.get("locations", [])):
            stop("sandbox_location_mismatch")
        matches, cursor, seen = [], "", set()
        while True:
            page = read(SQUARE_ORIGIN, "/v2/cards?include_disabled=true" + ("&cursor=" + urllib.parse.quote(cursor, safe="") if cursor else ""))
            matches.extend(r for r in page.get("cards", []) if r.get("reference_id") == REFERENCE)
            cursor = page.get("cursor")
            if not cursor:
                break
            if cursor in seen or len(seen) >= 40:
                stop("card_pagination_incomplete")
            seen.add(cursor)
        if len(matches) != 1:
            stop("existing_card_reference_not_unique")
        card = matches[0]
        card_id, customer_id = identifier(card.get("id")), identifier(card.get("customer_id"))
        brand, last4 = card.get("card_brand"), card.get("last_4")
        if card.get("enabled") is not True or brand not in BRANDS or not isinstance(last4, str) or not re.fullmatch(r"\d{4}", last4):
            stop("existing_card_receipt_invalid")
        customer = read(SQUARE_ORIGIN, "/v2/customers/" + urllib.parse.quote(customer_id, safe=""))["customer"]
        if customer.get("id") != customer_id or customer.get("reference_id") != REFERENCE or customer.get("given_name") != "Synthetic Fee QA":
            stop("synthetic_customer_binding_invalid")
        if any(customer.get(k) for k in ("email_address", "phone_number", "family_name", "address")):
            stop("customer_contact_present")
        salons = read(QA_ORIGIN, "/rest/v1/salons?" + urllib.parse.urlencode({"slug": "eq." + SLUG, "select": "id,name,slug,currency_code,payment_provider,sms_outbound_enabled,email_outbound_enabled,reminders_enabled,feature_flags"}))
        if len(salons) != 1:
            stop("qa_salon_not_unique")
        salon = salons[0]
        if salon.get("name") != NAME or salon.get("currency_code") != "CAD" or salon.get("payment_provider") != "square":
            stop("qa_salon_mismatch")
        if any(salon.get(k) is not False for k in ("sms_outbound_enabled", "email_outbound_enabled", "reminders_enabled")):
            stop("qa_notifications_not_disabled")
        if any((salon.get("feature_flags") or {}).get(k) is True for k in ("approved_no_show_charge_dispatch", "approved_cancellation_fee_dispatch")):
            stop("qa_fee_dispatch_must_remain_off_during_preparation")
        integrations = read(QA_ORIGIN, "/rest/v1/square_integrations?" + urllib.parse.urlencode({"salon_id": "eq." + salon["id"], "enabled": "eq.true", "select": "environment,merchant_id,application_id,location_id"}))
        if len(integrations) != 1 or integrations[0] != {"environment": "sandbox", "merchant_id": merchant, "application_id": app, "location_id": location}:
            stop("qa_square_binding_mismatch")
        verified_at = dt.datetime.now(dt.timezone.utc).isoformat()
        receipt = {"card_id": card_id, "customer_id": customer_id, "card_brand": brand, "card_last4": last4,
                   "environment": "sandbox", "merchant_id": merchant, "application_id": app, "location_id": location,
                   "provider_read_at": verified_at, "provider_card_reference": REFERENCE, "receipt_source": "existing_card_read"}
        prepared = render_sql(salon["id"], receipt)
        write_private(output / "fee-gui-fixture.private.sql", prepared)
        write_private(output / "fee-gui-receipt.private.json", json.dumps(receipt, indent=2))
        write_private(output / "fee-gui-plan.json", json.dumps({"status": "PREPARED_NOT_APPLIED", **plan, "readRequests": reads,
            "verifiedAt": verified_at, "receiptFingerprint": hashlib.sha256(json.dumps(receipt, sort_keys=True).encode()).hexdigest(),
            "requiresBeforeApply": "Reverify receipt if older than 15 minutes. Parent executes only against pinned QA project. Dispatch flags remain OFF until separate approved GUI execution."}, indent=2))
        print(json.dumps({"status": "PREPARED_NOT_APPLIED", "readRequests": reads, "scenarios": 3, "amountCentsEach": 100, "providerMutations": 0, "databaseMutations": 0}))
    finally:
        journal.close()


def render_sql(salon_id, receipt):
    # Only verified opaque identifiers, brand/last4 and timestamps enter SQL.
    # No provider token, client contact, full receipt, expiry or cardholder fields.
    return SQL.replace("__SALON__", literal(salon_id)).replace("__RECEIPT__", literal(json.dumps(receipt)))


SQL = r"""-- PREPARED ONLY: parent must execute against project osdqutwunokiielbairj.
-- Actual Square Sandbox card read; synthetic consent import, not app card-save QA.
-- No flags/config/provider/payment/notification mutation. Fresh namespace only.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SET LOCAL request.jwt.claim.role='service_role';
DO $fixture$
DECLARE
 s public.salons%ROWTYPE; receipt jsonb:=__RECEIPT__::jsonb;
 service uuid; worker uuid; owner_id uuid; booking uuid; cap uuid; review uuid; decision uuid;
 group_id uuid:='fd202609-2504-4000-8000-000000000003'; meta jsonb; result jsonb;
 policy text:='nsp_'||repeat('e',64); stamp timestamptz:=transaction_timestamp(); i integer;
BEGIN
 SELECT * INTO STRICT s FROM public.salons WHERE id=__SALON__::uuid AND slug='card-truth-preview-20260911';
 IF s.name IS DISTINCT FROM 'Synthetic Card Preview QA' OR s.currency_code IS DISTINCT FROM 'CAD'
    OR s.payment_provider IS DISTINCT FROM 'square' THEN RAISE EXCEPTION 'synthetic QA salon required'; END IF;
 IF s.sms_outbound_enabled IS DISTINCT FROM false OR s.email_outbound_enabled IS DISTINCT FROM false
    OR s.reminders_enabled IS DISTINCT FROM false THEN RAISE EXCEPTION 'QA outbound suppression required'; END IF;
 IF s.feature_flags->'approved_no_show_charge_dispatch'='true'::jsonb
    OR s.feature_flags->'approved_cancellation_fee_dispatch'='true'::jsonb THEN RAISE EXCEPTION 'fee dispatch must stay OFF for fixture creation'; END IF;
 IF (receipt->>'provider_read_at')::timestamptz < stamp-interval '15 minutes'
    OR (receipt->>'provider_read_at')::timestamptz > stamp+interval '1 minute'
    OR receipt->>'environment'<>'sandbox' THEN RAISE EXCEPTION 'fresh Sandbox receipt required'; END IF;
 IF (SELECT count(*) FROM public.square_integrations WHERE salon_id=s.id AND enabled IS TRUE)<>1
    OR NOT EXISTS(SELECT 1 FROM public.square_integrations WHERE salon_id=s.id AND enabled IS TRUE
      AND environment='sandbox' AND merchant_id=receipt->>'merchant_id'
      AND application_id=receipt->>'application_id' AND location_id=receipt->>'location_id') THEN
   RAISE EXCEPTION 'Square sandbox binding mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM public.bookings WHERE id::text LIKE 'fd202609-%') THEN
   RAISE EXCEPTION 'fixture exists: inspect/replay same review; never duplicate'; END IF;
 SELECT user_id INTO owner_id FROM public.salon_members WHERE salon_id=s.id AND role='owner' ORDER BY user_id LIMIT 1;
 SELECT id INTO service FROM public.services WHERE salon_id=s.id ORDER BY id LIMIT 1;
 SELECT id INTO worker FROM public.staff WHERE salon_id=s.id AND status='active' ORDER BY id LIMIT 1;
 IF owner_id IS NULL OR service IS NULL OR worker IS NULL THEN RAISE EXCEPTION 'existing QA owner/service/worker required'; END IF;
 FOR i IN 1..3 LOOP
   booking:=('fd202609-2500-4000-8000-'||lpad(i::text,12,'0'))::uuid;
   cap:=('fd202609-2501-4000-8000-'||lpad(i::text,12,'0'))::uuid;
   review:=('fd202609-2502-4000-8000-'||lpad(i::text,12,'0'))::uuid;
   decision:=('fd202609-2503-4000-8000-'||lpad(i::text,12,'0'))::uuid;
   meta:=jsonb_build_object('currency','CAD','scope',CASE WHEN i=3 THEN 'whole_party' ELSE 'booking_member' END,
     'policyVersion',policy,'feeCents',100,'qa_synthetic_consent',true,'qa_fixture','E2E Fee Sandbox GUI 20260925',
     'source','sandbox_gui_fixture','receiptSource','existing_card_read',
     'policyEn','Synthetic QA consent to a maximum CAD 1.00 late cancellation or no-show fee. No real customer.',
     'policyVi','Đồng ý giả lập QA với phí tối đa CAD 1.00. Không có khách thật.');
   INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,
     status,group_id,group_size,noshow_card_required,noshow_card_id,noshow_customer_id,noshow_card_brand,noshow_card_last4,
     noshow_consent_at,noshow_consent_meta,noshow_fee_cents,noshow_charge_status,customer_transition_version,customer_transition_kind)
   VALUES(booking,s.id,service,worker,'E2E Fee Sandbox GUI 20260925 '||CASE i WHEN 1 THEN 'NoShow' WHEN 2 THEN 'Late' ELSE 'Group' END,'',
     stamp-(5-i)*interval '90 minutes',stamp-(5-i)*interval '90 minutes'+interval '60 minutes',
     CASE WHEN i=1 THEN 'no_show' ELSE 'cancelled' END,CASE WHEN i=3 THEN group_id END,CASE WHEN i=3 THEN 2 END,
     true,receipt->>'card_id',receipt->>'customer_id',receipt->>'card_brand',receipt->>'card_last4',stamp,meta,100,'saved',1,'cancel');
   INSERT INTO public.booking_management_action_state(salon_id,booking_id,action) VALUES(s.id,booking,'card_manage');
   INSERT INTO public.booking_management_capabilities(id,salon_id,booking_id,action,scope_kind,epoch,booking_version,
     card_state_fingerprint,expires_at,revoked_at,revoke_reason)
   VALUES(cap,s.id,booking,'card_manage','booking_own',1,0,repeat('e',64),stamp+interval '1 second',stamp,'manual_revoke');
   INSERT INTO public.booking_card_save_operations(id,capability_id,salon_id,booking_id,request_id,provider,mode,
     source_fingerprint,initial_card_fingerprint,provider_material,status,attempt_token,provider_reference,
     completion_fingerprint,result_json,completed_at,recovery_consent_at,recovery_consent_meta,
     expected_customer_id,expected_merchant_id,expected_environment)
   VALUES(('fd202609-2505-4000-8000-'||lpad(i::text,12,'0'))::uuid,cap,s.id,booking,
     ('fd202609-2506-4000-8000-'||lpad(i::text,12,'0'))::uuid,'square','save_card',
     encode(extensions.digest(receipt::text,'sha256'),'hex'),repeat('e',64),
     jsonb_build_object('receipt_source','existing_card_read','qa_fixture','E2E Fee Sandbox GUI 20260925'),
     'succeeded',gen_random_uuid(),receipt->>'card_id',encode(extensions.digest(receipt::text,'sha256'),'hex'),
     receipt||jsonb_build_object('outcome','succeeded','code','saved','qa_fixture','E2E Fee Sandbox GUI 20260925'),
     stamp,stamp,meta,receipt->>'customer_id',receipt->>'merchant_id','sandbox');
   IF (SELECT public.booking_card_protection_state(b) FROM public.bookings b WHERE b.id=booking)<>'saved' THEN
     RAISE EXCEPTION 'verified imported QA receipt not recognized'; END IF;
   IF i=1 THEN
     INSERT INTO public.booking_no_show_decisions(id,salon_id,booking_id,state,original_status,requested_by_user_id,
       requested_by_role,assist_reason_code,requested_at,commit_after,committed_at)
     VALUES(decision,s.id,booking,'committed','confirmed',owner_id,'owner','desk_observation',stamp-interval '2 minutes',stamp-interval '1 minute',stamp);
     result:=public.request_booking_no_show_fee_review(review,decision,s.id,owner_id,'owner');
     IF result->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'no-show QA review failed'; END IF;
   ELSIF i=2 THEN
     INSERT INTO public.booking_late_cancellation_fee_reviews(id,salon_id,booking_id,cancellation_occurrence_version,
       amount_cents,currency,fee_percent,card_brand,card_last4,consent_at,consent_policy_version,policy_snapshot)
     VALUES(review,s.id,booking,1,100,'CAD',20,receipt->>'card_brand',receipt->>'card_last4',stamp,policy,meta);
   ELSE
     INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,
       status,group_id,group_size,noshow_card_required)
     VALUES('fd202609-2500-4000-8000-000000000004',s.id,service,worker,'E2E Fee Sandbox GUI 20260925 GroupGuest','',
       stamp-interval '3 hours',stamp-interval '2 hours','cancelled',group_id,2,false);
     INSERT INTO public.booking_group_cancellation_fee_reviews(id,salon_id,group_id,cancellation_request_id,
       organizer_booking_id,state,amount_cents,currency,card_brand,card_last4,consent_policy_version,policy_snapshot,requested_by_user_id,requested_by_role)
     VALUES(review,s.id,group_id,'fd202609-2507-4000-8000-000000000003',booking,'pending_review',100,'CAD',
       receipt->>'card_brand',receipt->>'card_last4',policy,meta,owner_id,'owner');
   END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.booking_payment_operations WHERE booking_id::text LIKE 'fd202609-%') THEN
   RAISE EXCEPTION 'fixture must not create payment operations'; END IF;
END;
$fixture$;
SELECT id,client_name,status FROM public.bookings WHERE id::text LIKE 'fd202609-2500-%' ORDER BY id;
COMMIT;
"""

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Never echo HTTP bodies, URLs, tokens, customer IDs or contact fields.
        code = str(exc) if isinstance(exc, RuntimeError) and re.fullmatch(r"[a-z_]+", str(exc)) else "preparation_failed_inspect_private_journal"
        print(json.dumps({"status": "BLOCKED", "reason": code}), file=sys.stderr)
        sys.exit(1)
