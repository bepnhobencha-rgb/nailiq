import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TurnIqOperationsPanel } from "@/components/receptionist/TurnIqOperationsPanel";
import type {
  TurnIqExceptionInboxView,
  TurnIqLiveBoardView,
  TurnIqStaffView,
} from "@/shared/turniq/readModels";

const policyVersionId = "11111111-1111-4111-8111-111111111111";

function board(): TurnIqLiveBoardView {
  return {
    businessDate: "2026-09-02",
    activePolicyVersionId: policyVersionId,
    ownerActionRequired: true,
    ownerFreedomMessage: "Owner review is needed.",
    openExceptionCount: 1,
    nextRecommendation: null,
    redoCandidates: [],
    swaps: [],
    recentCorrections: [],
    staff: [
      {
        staffId: "staff-1",
        staffName: "Mai",
        state: "active",
        queuePosition: 1,
        turnsConsumed: 2,
        isRecommendedNext: false,
      },
      {
        staffId: "staff-2",
        staffName: "Linh",
        state: "not_checked_in",
        queuePosition: null,
        turnsConsumed: 0,
        isRecommendedNext: false,
      },
    ],
    assignments: [
      {
        assignmentId: "assignment-1",
        policyVersionId,
        bookingId: "booking-1",
        status: "confirmed",
        serviceName: "Deluxe Pedicure",
        assignedStaffId: "staff-1",
        recommendedStaffName: "Mai",
        assignedStaffName: "Mai",
        explanation: "Mai is available and qualified.",
      },
    ],
  };
}

function staffView(): TurnIqStaffView {
  return {
    staffId: "staff-1",
    staffName: "Mai",
    businessDate: "2026-09-02",
    activePolicyVersionId: policyVersionId,
    shiftState: "active",
    queuePosition: 1,
    turnsConsumed: 2,
    ownOpportunityCreditCents: 10_000,
    currentAssignment: {
      assignmentId: "assignment-1",
      policyVersionId,
      status: "confirmed",
      serviceName: "Deluxe Pedicure",
      explanation: "Mai is available and qualified.",
    },
    whyNotMe: [
      {
        assignmentId: "assignment-2",
        policyVersionId,
        serviceName: "Gel Manicure",
        reasonCodes: ["INSUFFICIENT_APPOINTMENT_GAP"],
        explanation:
          "Not eligible for this customer: there is not enough safe time before your next appointment.",
        decidedAt: "2026-09-02T18:05:00.000Z",
        dispute: null,
      },
    ],
    recentRefusals: [
      {
        assignmentId: "assignment-refused",
        serviceName: "Classic Manicure",
        category: "customer_declined",
        outcome: "no_penalty",
        reason: "Customer preferred another technician.",
        refusedAt: "2026-09-02T18:04:00.000Z",
      },
    ],
    recentRedos: [
      {
        assignmentId: "assignment-redo",
        serviceName: "Classic Manicure",
        category: "quality_issue",
        note: "Repair one chipped nail under the salon guarantee.",
        consumesTurn: false,
        creditsOpportunity: false,
        classifiedAt: "2026-09-02T18:06:00.000Z",
      },
    ],
    pendingSwaps: [],
    recentCorrections: [],
    recentReceipts: [
      {
        id: "receipt-1",
        policyVersionId,
        assignmentId: "assignment-1",
        outcome: "confirmed_recommendation",
        explanation: "Mai was available and safe before the next appointment.",
        requestedTechSource: null,
        requestTrustLabel: null,
        skippedReasonCodes: [],
        overrideReason: null,
        dispute: null,
        createdAt: "2026-09-02T18:01:00.000Z",
      },
    ],
  };
}

const inbox: TurnIqExceptionInboxView = {
  ownerActionRequired: true,
  message: "One exception needs review.",
  exceptions: [
    {
      id: "exception-1",
      policyVersionId,
      assignmentId: "assignment-1",
      disputeId: null,
      exceptionType: "appointment_risk",
      status: "open",
      privacySafeSummary: "Upcoming appointment needs review.",
      recommendedAction: "Choose another qualified technician.",
      stateVersion: 1,
      createdAt: "2026-09-02T18:00:00.000Z",
      dispute: null,
    },
  ],
};

const actions = {
  onApplyShiftCommand: async () => ({
    ok: false as const,
    code: "stale_state" as const,
  }),
  onApplyAssignmentCommand: async () => ({
    ok: false as const,
    code: "stale_state" as const,
  }),
  onConfigureStaffPin: async () => ({
    ok: false as const,
    code: "stale_state" as const,
  }),
  onApplyPinShiftCommand: async () => ({
    ok: false as const,
    code: "stale_state" as const,
  }),
  onApplyRefusalCommand: async () => ({
    ok: false as const,
    code: "stale_state" as const,
  }),
  onApplyRedoCommand: async () => ({
    ok: false as const,
    code: "stale_state" as const,
  }),
  onApplySwapCommand: async () => ({
    ok: false as const,
    code: "stale_state" as const,
  }),
  onApplyCorrectionCommand: async () => ({
    ok: false as const,
    code: "stale_state" as const,
  }),
  onCreateDispute: async () => ({
    ok: false as const,
    code: "stale_state" as const,
  }),
  onCreateSkipDispute: async () => ({
    ok: false as const,
    code: "stale_state" as const,
  }),
  onResolveDispute: async () => ({
    ok: false as const,
    code: "stale_state" as const,
  }),
  onApplyExceptionCommand: async () => ({
    ok: false as const,
    code: "stale_state" as const,
  }),
  onRefresh: async () => undefined,
};

describe("TurnIQ operational surfaces", () => {
  it("shows one-tap team controls, active service action and owner exception guidance", () => {
    const liveBoard = board();
    liveBoard.nextRecommendation = {
      assignmentId: "assignment-next",
      policyVersionId,
      bookingId: "booking-next",
      recommendedStaffId: "staff-1",
      recommendedStaffName: "Mai",
      serviceName: "Classic Manicure",
      explanation: "Mai is next under the active policy.",
      requestedTechTrustLabel: null,
      redo: null,
      skipped: [],
    };
    liveBoard.redoCandidates = [
      {
        assignmentId: "assignment-original",
        policyVersionId,
        serviceName: "Classic Manicure",
        assignedStaffId: "staff-1",
        assignedStaffName: "Mai",
        completedAt: "2026-09-01T18:00:00.000Z",
      },
    ];
    const html = renderToStaticMarkup(
      createElement(TurnIqOperationsPanel, {
        board: liveBoard,
        staffView: null,
        exceptionInbox: inbox,
        language: "vi",
        slug: "salon-a",
        rolloutStage: "supervised",
        offline: false,
        canManageTeam: true,
        canConfigureStaffPin: true,
        canSeeExceptionInbox: true,
        canCorrectRecords: true,
        ...actions,
      }),
    );
    expect(html).toContain("Đội ngũ hôm nay");
    expect(html).toContain("Check-in bằng PIN thợ");
    expect(html).toContain("Đặt / đổi PIN");
    expect(html).toContain("Nghỉ");
    expect(html).toContain("Check-in");
    expect(html).toContain("Bắt đầu");
    expect(html).toContain("Ngoại lệ cần chủ salon");
    expect(html).toContain("Choose another qualified technician.");
    expect(html).toContain("Đã nhận");
    expect(html).toContain("Giải quyết");
    expect(html).toContain("Ghi nhận không nhận lượt");
    expect(html).toContain("không phạt nhầm hoặc đổi lượt âm thầm");
    expect(html).toContain("Đánh dấu redo");
    expect(html).toContain("TurnIQ tự lấy quy tắc lượt và credit của salon");
    expect(html).toContain("Đổi thợ có đồng thuận");
    expect(html).toContain("Đề nghị đổi");
    expect(html).toContain("Sửa người thực sự làm");
    expect(html).toContain("Receipt gốc giữ nguyên");
  });

  it("shows only the technician's own turn and assignment without peer money", () => {
    const html = renderToStaticMarkup(
      createElement(TurnIqOperationsPanel, {
        board: null,
        staffView: staffView(),
        exceptionInbox: null,
        language: "en",
        slug: "salon-a",
        rolloutStage: "supervised",
        offline: false,
        canManageTeam: false,
        canConfigureStaffPin: false,
        canSeeExceptionInbox: false,
        canCorrectRecords: false,
        ...actions,
      }),
    );
    expect(html).toContain("My turn");
    expect(html).toContain("Mai");
    expect(html).toContain("Deluxe Pedicure");
    expect(html).toContain("My Fairness Receipts");
    expect(html).toContain("Why not me?");
    expect(html).toContain("Request reason review");
    expect(html).toContain("not enough safe time before your next appointment");
    expect(html).toContain("Flag for review");
    expect(html).toContain("Turns not accepted");
    expect(html).toContain("Customer preferred another technician.");
    expect(html).toContain("No penalty");
    expect(html).toContain("My redo / repair work");
    expect(html).toContain("No turn");
    expect(html).toContain("No opportunity credit");
    expect(html).not.toContain("Linh");
    expect(html).not.toMatch(/revenue|peer|tip|\$100/i);
  });
});
