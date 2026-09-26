"""Read-only post-GUI fee verification: pinned synthetic QA and Square Sandbox.

No RPC, POST, provider mutation, auth change, or configuration update. Run once
after Collect, then again with --baseline after duplicate/reload GUI checks.
This verifies each ledger-linked provider receipt and a bounded provider list
for duplicate reference IDs. Independent browser evidence remains necessary.
Private inputs must live outside the repository with mode 0600.
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

ROOT = pathlib.Path(__file__).resolve().parents[2]
QA = "https://osdqutwunokiielbairj.supabase.co"
SQUARE = "https://connect.squareupsandbox.com"
SLUG = "card-truth-preview-20260911"
KINDS = ("no_show", "late_cancellation", "group_cancellation")


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def private_json(filename):
    p = pathlib.Path(filename).resolve(strict=True)
    require(not p.is_relative_to(ROOT) and not p.stat().st_mode & 0o077,
            "external_private_input_required")
    return json.loads(p.read_text())


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError("redirect_denied")


class Reader:
    def __init__(self, qa, square):
        self.qa, self.square, self.requests = qa, square, 0

    def get(self, origin, path, query=None):
        require(path.startswith("/") and "?" not in path and "#" not in path, "invalid_path")
        if origin == QA:
            tables = {"salons", "square_integrations", "bookings", "booking_payment_operations"}
            tables |= {"booking_" + kind + "_fee_" + suffix
                       for kind in KINDS for suffix in ("reviews", "approval_receipts")}
            require(path in {"/rest/v1/" + table for table in tables}, "table_denied")
            key = self.qa["SUPABASE_SERVICE_ROLE_KEY"]
            headers = {"apikey": key, "Authorization": "Bearer " + key}
        elif origin == SQUARE:
            if path == "/v2/payments":
                require(isinstance(query, dict) and set(query) <= {"begin_time", "end_time", "location_id", "limit", "cursor"}
                        and query.get("location_id") == self.square.get("NAILIQ_QA_SQUARE_SANDBOX_LOCATION_ID")
                        and query.get("location_id") and query.get("limit") == "100"
                        and query.get("begin_time") and query.get("end_time"), "provider_list_bounds_required")
                start, end = parse_time(query["begin_time"]), parse_time(query["end_time"])
                require(dt.timedelta(0) < end - start <= dt.timedelta(hours=24), "provider_list_window_invalid")
            else:
                require(bool(re.fullmatch(r"/v2/payments/[A-Za-z0-9_-]+", path)) and not query, "provider_route_denied")
            headers = {"Authorization": "Bearer " + self.square["NAILIQ_QA_SQUARE_SANDBOX_ACCESS_TOKEN"],
                       "Square-Version": "2024-12-18"}
        else:
            raise RuntimeError("origin_denied")
        self.requests += 1
        require(self.requests <= 30, "read_budget_exhausted")
        url = origin + path + ("?" + urllib.parse.urlencode(query) if query else "")
        request = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
            result = json.load(response)
        require(not isinstance(result, dict) or not result.get("errors"), "provider_read_rejected")
        return result

    def rows(self, table, **query):
        result = self.get(QA, "/rest/v1/" + table, query)
        require(isinstance(result, list), "invalid_database_result")
        return result


def only(rows, code):
    require(len(rows) == 1, code)
    return rows[0]


def parse_time(value):
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(parsed.tzinfo is not None and parsed.utcoffset() == dt.timedelta(0), "utc_timestamp_required")
    return parsed


def verify_provider_matches(reader, receipt, references, created_after):
    # Bounded Sandbox list detects payments absent from the DB ledger as well.
    now = dt.datetime.now(dt.timezone.utc)
    start = parse_time(created_after) if created_after else parse_time(receipt["provider_read_at"]) - dt.timedelta(minutes=5)
    require(dt.timedelta(0) < now - start <= dt.timedelta(hours=24), "provider_list_window_invalid")
    query = {"begin_time": start.isoformat(), "end_time": now.isoformat(),
             "location_id": receipt["location_id"], "limit": "100"}
    matches = {reference: [] for reference in references}
    seen = set()
    for _ in range(10):
        page = reader.get(SQUARE, "/v2/payments", query)
        require(isinstance(page.get("payments", []), list), "invalid_payment_list")
        for payment in page.get("payments", []):
            reference = payment.get("reference_id")
            if reference in matches:
                matches[reference].append(payment)
        cursor = page.get("cursor")
        if not cursor:
            break
        require(isinstance(cursor, str) and len(cursor) <= 4096 and cursor not in seen, "provider_list_cursor_invalid")
        seen.add(cursor)
        query["cursor"] = cursor
    else:
        raise RuntimeError("provider_list_incomplete")
    for reference, expected_id in references.items():
        payment = only(matches[reference], "provider_reference_count_not_one")
        require(payment.get("id") == expected_id and payment.get("status") == "COMPLETED",
                "provider_list_not_settled_or_mismatched")
    return {"beginTime": start.isoformat(), "endTime": now.isoformat(),
            "complete": True, "matchingPayments": len(references)}


def verify_case(kind, booking, review, approvals, operations, payment, receipt):
    op = only(operations, "operation_count_not_one")
    approval = only(approvals, "approval_receipt_count_not_one")
    require(review["state"] == "approved_charge" and review["payment_status"] == "succeeded", "review_not_paid")
    require(op["id"] == review["payment_operation_id"] and op["booking_id"] == booking["id"], "operation_binding_mismatch")
    require(op["provider"] == "square" and op["status"] == "succeeded" and op.get("completed_at"), "operation_not_completed")
    require(op["operation_kind"] == ("noshow_charge" if kind == "no_show" else "late_cancel_charge"), "operation_kind_mismatch")
    require(approval["action"] == "charge" and approval["review_id"] == review["id"]
            and approval["approval_request_id"] == review["approval_request_id"], "approval_binding_mismatch")
    for row in (op, review, approval):
        require(row["amount_cents"] == 100 and row["currency"] == "CAD", "fee_amount_mismatch")
        require(row["salon_id"] == booking["salon_id"], "tenant_mismatch")
    require(op["request_reference"] == booking["id"], "request_reference_mismatch")
    require(op["material_customer_id"] == receipt["customer_id"]
            and op["material_card_id"] == receipt["card_id"], "material_card_binding_mismatch")
    require(booking["noshow_card_id"] == receipt["card_id"]
            and booking["noshow_customer_id"] == receipt["customer_id"], "booking_card_binding_mismatch")
    require(op["result_status"] == "succeeded" and op["result_payment_id"] == op["provider_payment_id"]
            and int(op["result_amount"]) == 100 and op["result_currency"] == "CAD", "durable_receipt_mismatch")
    require(payment.get("id") == op["provider_payment_id"] and payment.get("status") == "COMPLETED", "square_payment_not_completed")
    require(payment.get("amount_money") == {"amount": 100, "currency": "CAD"}, "square_amount_mismatch")
    require(payment.get("location_id") == receipt["location_id"]
            and payment.get("customer_id") == receipt["customer_id"]
            and payment.get("reference_id") == booking["id"], "square_binding_mismatch")
    card = (payment.get("card_details") or {}).get("card") or {}
    require(card.get("card_brand") == receipt["card_brand"] and card.get("last_4") == receipt["card_last4"], "square_card_mismatch")
    prefix = "noshow" if kind == "no_show" else "late_cancel"
    require(booking[prefix + "_charge_status"] == "charged"
            and booking[prefix + "_payment_id"] == op["provider_payment_id"]
            and booking[prefix + "_payment_ledger_enforced_at"], "booking_projection_mismatch")
    if kind != "no_show":
        require(booking["late_cancel_charged_cents"] == 100 and booking["late_cancel_refunded_cents"] == 0,
                "cancellation_projection_mismatch")
    # Hash only immutable payment/approval evidence; no timestamps which change
    # on safe read/replay, no secrets or provider response body in output.
    immutable = {"operation": op, "approval": approval,
                 "payment": {k: payment.get(k) for k in ("id", "status", "amount_money", "customer_id", "location_id", "reference_id")}}
    return {"scenario": kind, "status": "PASS", "amountCents": 100, "currency": "CAD",
            "operationCount": 1, "approvalReceiptCount": 1, "immutableFingerprint": fingerprint(immutable),
            "paymentFingerprint": fingerprint(payment["id"])}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--qa-credentials")
    ap.add_argument("--square-credentials")
    ap.add_argument("--verified-card-receipt")
    ap.add_argument("--created-after", help="UTC start of GUI test, within 24 hours; default verified card read minus 5 minutes")
    ap.add_argument("--baseline", help="Prior sanitized successful report, to prove replay leaves evidence unchanged")
    args = ap.parse_args()
    if not args.verify:
        print(json.dumps({"status": "OFFLINE_PLAN_ONLY", "project": QA, "scenarios": list(KINDS),
                          "providerMethods": ["GET"], "providerRoutes": ["/v2/payments/:id", "/v2/payments (bounded)"], "mutations": 0}))
        return
    require(os.environ.get("NAILIQ_FEE_GUI_READONLY_APPROVED") == "1", "read_only_opt_in_required")
    require(all((args.qa_credentials, args.square_credentials, args.verified_card_receipt)), "private_inputs_required")
    qa, square, receipt = map(private_json, (args.qa_credentials, args.square_credentials, args.verified_card_receipt))
    require((qa.get("SUPABASE_URL") or qa.get("NEXT_PUBLIC_SUPABASE_URL", "")).rstrip("/") == QA, "qa_project_mismatch")
    require(receipt.get("environment") == "sandbox" and receipt.get("receipt_source") == "existing_card_read", "sandbox_receipt_required")
    for name in ("application_id", "merchant_id", "location_id"):
        require(receipt[name] == square["NAILIQ_QA_SQUARE_SANDBOX_" + name.upper()], "sandbox_configuration_mismatch")
    require(receipt["application_id"].startswith("sandbox-sq0idb-"), "sandbox_application_required")
    reader = Reader(qa, square)
    salon = only(reader.rows("salons", slug="eq." + SLUG, select="id,name,slug,payment_provider,currency_code"), "salon_count_mismatch")
    require(salon["name"] == "Synthetic Card Preview QA" and salon["payment_provider"] == "square"
            and salon["currency_code"] == "CAD", "synthetic_salon_required")
    integration = only(reader.rows("square_integrations", salon_id="eq." + salon["id"], enabled="eq.true",
                                  select="environment,merchant_id,application_id,location_id"), "integration_count_mismatch")
    require(integration == {k: receipt[k] for k in integration}, "integration_binding_mismatch")
    results, references = [], {}
    for index, kind in enumerate(KINDS, 1):
        bid = "fd202609-2500-4000-8000-" + str(index).zfill(12)
        rid = "fd202609-2502-4000-8000-" + str(index).zfill(12)
        scoped = {"salon_id": "eq." + salon["id"]}
        booking = only(reader.rows("bookings", **scoped, id="eq." + bid, select="id,salon_id,noshow_card_id,noshow_customer_id,noshow_charge_status,noshow_payment_id,noshow_payment_ledger_enforced_at,late_cancel_charge_status,late_cancel_payment_id,late_cancel_payment_ledger_enforced_at,late_cancel_charged_cents,late_cancel_refunded_cents"), "booking_count_mismatch")
        review = only(reader.rows("booking_" + kind + "_fee_reviews", **scoped, id="eq." + rid,
                                 select="id,salon_id,state,payment_status,payment_operation_id,approval_request_id,amount_cents,currency"), "review_count_mismatch")
        approvals = reader.rows("booking_" + kind + "_fee_approval_receipts", **scoped, review_id="eq." + rid,
                                select="id,salon_id,review_id,approval_request_id,action,amount_cents,currency")
        operations = reader.rows("booking_payment_operations", **scoped, booking_id="eq." + bid,
                                 select="id,salon_id,booking_id,operation_kind,provider,status,amount_cents,currency,completed_at,provider_payment_id,material_fingerprint,provider_idempotency_key,request_reference:material_json->>provider_request_reference,material_customer_id:provider_material->>customer_id,material_card_id:provider_material->>saved_card_id,result_status:result_json->>status,result_payment_id:result_json->>provider_payment_id,result_amount:result_json->>amount_cents,result_currency:result_json->>currency")
        op = only(operations, "operation_count_not_one")
        pid = op.get("provider_payment_id", "") or ""
        require(bool(re.fullmatch(r"[A-Za-z0-9_-]+", pid)), "invalid_payment_identifier")
        payment = reader.get(SQUARE, "/v2/payments/" + pid).get("payment", {})
        results.append(verify_case(kind, booking, review, approvals, operations, payment, receipt))
        references[bid] = pid
    require(len({row["paymentFingerprint"] for row in results}) == 3, "payment_reused_across_reviews")
    provider_scan = verify_provider_matches(reader, receipt, references, args.created_after)
    replay = "NOT_CHECKED"
    if args.baseline:
        baseline = json.loads(pathlib.Path(args.baseline).read_text())
        require(baseline.get("status") == "PASS" and baseline.get("results") == results, "replay_evidence_changed")
        replay = "PASS_UNCHANGED"
    print(json.dumps({"status": "PASS", "verifiedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                      "results": results, "replay": replay, "readRequests": reader.requests,
                      "providerScan": provider_scan, "mutations": 0,
                      "coverage": "Ledger plus complete bounded provider reference scan; independent GUI evidence required"}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        code = str(exc) if isinstance(exc, RuntimeError) and re.fullmatch(r"[a-z_]+", str(exc)) else "verification_read_failed"
        print(json.dumps({"status": "FAIL", "reason": code}), file=sys.stderr)
        sys.exit(1)
