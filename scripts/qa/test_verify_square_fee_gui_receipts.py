"""Offline negative controls for the read-only fee receipt verifier."""
import copy
import importlib.util
import pathlib
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location("receipt_probe", pathlib.Path(__file__).with_name("verify-square-fee-gui-receipts.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def fixture(kind="no_show"):
    receipt = {"card_id": "card", "customer_id": "customer", "location_id": "location", "card_brand": "VISA", "card_last4": "1111"}
    booking = {"id": "booking", "salon_id": "salon", "noshow_card_id": "card", "noshow_customer_id": "customer",
               "noshow_charge_status": "charged", "noshow_payment_id": "payment", "noshow_payment_ledger_enforced_at": "timestamp",
               "late_cancel_charge_status": "charged", "late_cancel_payment_id": "payment", "late_cancel_payment_ledger_enforced_at": "timestamp",
               "late_cancel_charged_cents": 100, "late_cancel_refunded_cents": 0}
    review = {"id": "review", "salon_id": "salon", "state": "approved_charge", "payment_status": "succeeded",
              "payment_operation_id": "operation", "approval_request_id": "request", "amount_cents": 100, "currency": "CAD"}
    approval = {"id": "approval", "salon_id": "salon", "review_id": "review", "approval_request_id": "request", "action": "charge", "amount_cents": 100, "currency": "CAD"}
    op = {"id": "operation", "salon_id": "salon", "booking_id": "booking", "provider": "square", "status": "succeeded", "completed_at": "timestamp",
          "operation_kind": "noshow_charge" if kind == "no_show" else "late_cancel_charge", "amount_cents": 100, "currency": "CAD", "request_reference": "booking",
          "material_customer_id": "customer", "material_card_id": "card", "result_status": "succeeded", "result_payment_id": "payment", "provider_payment_id": "payment",
          "result_amount": "100", "result_currency": "CAD"}
    payment = {"id": "payment", "status": "COMPLETED", "amount_money": {"amount": 100, "currency": "CAD"}, "location_id": "location", "customer_id": "customer",
               "reference_id": "booking", "card_details": {"card": {"card_brand": "VISA", "last_4": "1111"}}}
    return [kind, booking, review, [approval], [op], payment, receipt]


class ReceiptProbeTests(unittest.TestCase):
    def test_three_scenarios_pass_and_same_receipt_is_stable(self):
        for kind in probe.KINDS:
            args = fixture(kind)
            first = probe.verify_case(*args)
            self.assertEqual(first["status"], "PASS")
            self.assertEqual(first, probe.verify_case(*copy.deepcopy(args)))

    def test_negative_controls(self):
        cases = [
            (lambda a: a[4].append(copy.deepcopy(a[4][0])), "operation_count_not_one"),
            (lambda a: a[3].append(copy.deepcopy(a[3][0])), "approval_receipt_count_not_one"),
            (lambda a: a[2].update(payment_status="unknown"), "review_not_paid"),
            (lambda a: a[4][0].update(status="unknown"), "operation_not_completed"),
            (lambda a: a[4][0].update(salon_id="other"), "tenant_mismatch"),
            (lambda a: a[4][0].update(result_payment_id="other"), "durable_receipt_mismatch"),
            (lambda a: a[5].update(status="FAILED"), "square_payment_not_completed"),
            (lambda a: a[5].update(amount_money={"amount": 100, "currency": "USD"}), "square_amount_mismatch"),
            (lambda a: a[5].update(customer_id="other"), "square_binding_mismatch"),
            (lambda a: a[5].update(location_id="other"), "square_binding_mismatch"),
            (lambda a: a[5].update(reference_id="other"), "square_binding_mismatch"),
            (lambda a: a[5]["card_details"]["card"].update(last_4="2222"), "square_card_mismatch"),
            (lambda a: a[1].update(noshow_charge_status="saved"), "booking_projection_mismatch"),
        ]
        for mutate, reason in cases:
            with self.subTest(reason=reason):
                args = fixture()
                mutate(args)
                with self.assertRaisesRegex(RuntimeError, "^" + reason + "$"):
                    probe.verify_case(*args)

    def test_network_boundaries_reject_before_any_request(self):
        reader = probe.Reader({}, {})
        for origin, path in [("https://connect.squareup.com", "/v2/payments/payment"),
                             (probe.SQUARE, "/v2/payments"), (probe.SQUARE, "/v2/customers/customer"),
                             (probe.QA, "/rest/v1/rpc/claim_payment"), (probe.QA, "/auth/v1/admin/users")]:
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                reader.get(origin, path)
        self.assertEqual(reader.requests, 0)

    def test_bounded_provider_list_detects_unlinked_duplicate(self):
        receipt = {"location_id": "location", "provider_read_at": probe.dt.datetime.now(probe.dt.timezone.utc).isoformat()}
        payment = {"id": "payment", "reference_id": "booking", "status": "COMPLETED"}
        for rows, outcome in [([payment], None), ([], "provider_reference_count_not_one"),
                              ([payment, {**payment, "id": "unlinked"}], "provider_reference_count_not_one"),
                              ([{**payment, "status": "APPROVED"}], "provider_list_not_settled_or_mismatched")]:
            reader = Mock()
            reader.get.return_value = {"payments": rows}
            if outcome:
                with self.assertRaisesRegex(RuntimeError, outcome):
                    probe.verify_provider_matches(reader, receipt, {"booking": "payment"}, None)
            else:
                self.assertTrue(probe.verify_provider_matches(reader, receipt, {"booking": "payment"}, None)["complete"])

    def test_incomplete_provider_list_never_passes(self):
        receipt = {"location_id": "location", "provider_read_at": probe.dt.datetime.now(probe.dt.timezone.utc).isoformat()}
        reader = Mock()
        reader.get.side_effect = [{"payments": [], "cursor": str(n)} for n in range(10)]
        with self.assertRaisesRegex(RuntimeError, "provider_list_incomplete"):
            probe.verify_provider_matches(reader, receipt, {"booking": "payment"}, None)
        self.assertEqual(reader.get.call_count, 10)

    def test_provider_list_requires_explicit_bounded_sandbox_location(self):
        reader = probe.Reader({}, {"NAILIQ_QA_SQUARE_SANDBOX_LOCATION_ID": "location"})
        with self.assertRaisesRegex(RuntimeError, "provider_list_bounds_required"):
            reader.get(probe.SQUARE, "/v2/payments", {"location_id": "other"})
        with self.assertRaisesRegex(RuntimeError, "provider_list_window_invalid"):
            reader.get(probe.SQUARE, "/v2/payments", {"location_id": "location", "limit": "100",
                       "begin_time": "2026-09-01T00:00:00Z", "end_time": "2026-09-25T00:00:00Z"})
        self.assertEqual(reader.requests, 0)


if __name__ == "__main__":
    unittest.main()
