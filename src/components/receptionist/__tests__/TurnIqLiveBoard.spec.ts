import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TurnIqLiveBoard } from "@/components/receptionist/TurnIqLiveBoard";
import type { TurnIqLiveBoardView } from "@/shared/turniq/readModels";

function board(): TurnIqLiveBoardView {
  return {
    businessDate: "2026-09-02",
    activePolicyVersionId: "11111111-1111-4111-8111-111111111111",
    ownerActionRequired: false,
    ownerFreedomMessage: "No owner action needed.",
    openExceptionCount: 0,
    nextRecommendation: {
      assignmentId: "assignment-1",
      policyVersionId: "11111111-1111-4111-8111-111111111111",
      bookingId: "booking-1",
      recommendedStaffId: "staff-1",
      recommendedStaffName: "Mai",
      serviceName: "Deluxe Pedicure",
      explanation:
        "Recommend Mai: available now, qualified, and safe before the next appointment.",
      requestedTechTrustLabel: null,
      redo: null,
      skipped: [
        {
          staffId: "staff-2",
          staffName: "Linh",
          reasonCodes: ["INSUFFICIENT_APPOINTMENT_GAP"],
        },
      ],
    },
    redoCandidates: [],
    swaps: [],
    recentCorrections: [],
    staff: [],
    assignments: [],
  };
}

describe("TurnIQ Live Board", () => {
  it("makes the next technician and privacy-safe skip reason obvious", () => {
    const html = renderToStaticMarkup(
      createElement(TurnIqLiveBoard, {
        board: board(),
        errorCode: null,
        language: "vi",
      }),
    );
    expect(html).toContain("Lượt tiếp theo");
    expect(html).toContain("Mai");
    expect(html).toContain("Deluxe Pedicure");
    expect(html).toContain("không đủ thời gian trước lịch kế tiếp");
    expect(html).toContain("Không cần chủ can thiệp");
    expect(html).not.toMatch(/\$|revenue|tip|6000/i);
  });

  it("fails visibly without claiming an assignment when the server cannot verify", () => {
    const html = renderToStaticMarkup(
      createElement(TurnIqLiveBoard, {
        board: null,
        errorCode: "stale_state",
        language: "vi",
      }),
    );
    expect(html).toContain("TurnIQ chưa thể xác minh lượt");
    expect(html).toContain("chưa tự gán thợ");
  });

  it("shows one-tap confirmation and an audited override path only with handlers", () => {
    const html = renderToStaticMarkup(
      createElement(TurnIqLiveBoard, {
        board: board(),
        errorCode: null,
        language: "vi",
        slug: "salon-a",
        canManage: true,
        onApplyCommand: async () => ({
          ok: false as const,
          code: "stale_state" as const,
        }),
      }),
    );
    expect(html).toContain("Xác nhận Mai");
    expect(html).toContain("Chọn người khác");
    expect(html).not.toContain("Lý do bắt buộc");
  });

  it("blocks confirmation visibly when an assignment exception is open", () => {
    const blocked = board();
    blocked.nextRecommendation = {
      ...blocked.nextRecommendation!,
      blockedByException: true,
    };
    const html = renderToStaticMarkup(
      createElement(TurnIqLiveBoard, {
        board: blocked,
        errorCode: null,
        language: "vi",
        slug: "salon-a",
        canManage: true,
        onApplyCommand: async () => ({
          ok: false as const,
          code: "stale_state" as const,
        }),
      }),
    );
    expect(html).toContain("Chưa thể xác nhận");
    expect(html).toContain("disabled");
  });
});
