import { describe, expect, it } from "vitest";

import {
  deskRefundOutcomeMessage,
  isCommittedCancellationPaymentPending,
  publicDepositFailureMessage,
} from "../paymentOutagePresentation";

describe("MQA-0204 customer-facing payment outage truth", () => {
  it.each([
    "deposit_pending",
    "provider_outcome_unknown",
    "completion_write_uncertain",
    "pending_provider",
    "processing",
    "requires_capture",
  ])("tells a public customer not to pay again for %s", (code) => {
    const message = publicDepositFailureMessage(code);
    expect(message).toContain("Do not pay again");
    expect(message).toContain("Không thanh toán lại");
    expect(message).toContain("same payment status");
  });

  it("preserves localized pending copy separately from a definite error", () => {
    expect(publicDepositFailureMessage("deposit_pending", {
      error: "Lỗi thanh toán",
      pending: "Đang đối soát giao dịch cũ",
    })).toBe("Đang đối soát giao dịch cũ");
    expect(publicDepositFailureMessage("provider_rejected", {
      error: "Lỗi thanh toán",
      pending: "Đang đối soát giao dịch cũ",
    })).toBe("Lỗi thanh toán");
  });

  it.each(["pending_provider", "unknown"] as const)(
    "recognizes a committed cancellation with %s fee truth",
    (feeStatus) => {
      expect(isCommittedCancellationPaymentPending({
        ok: false,
        code: "payment_reconciliation_required",
        bookingCommitted: true,
        feeStatus,
      })).toBe(true);
    },
  );

  it("does not turn an uncommitted or definite failure into a committed pending state", () => {
    expect(isCommittedCancellationPaymentPending({
      code: "payment_reconciliation_required",
      bookingCommitted: false,
      feeStatus: "unknown",
    })).toBe(false);
    expect(isCommittedCancellationPaymentPending({
      code: "payment_reconciliation_required",
      bookingCommitted: true,
      feeStatus: "definite_failure",
    })).toBe(false);
  });

  it("distinguishes desk refund pending, unknown, and definite failure without suggesting a new refund", () => {
    expect(deskRefundOutcomeMessage("pending_provider")).toContain("nhà cung cấp đang xử lý");
    expect(deskRefundOutcomeMessage("unknown")).toContain("chưa xác định");
    expect(deskRefundOutcomeMessage("unknown")).toContain("không tạo yêu cầu hoàn mới");
    expect(deskRefundOutcomeMessage("definite_failure", "declined")).toContain("bị từ chối (declined)");
  });
});
