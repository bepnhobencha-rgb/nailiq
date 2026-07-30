import { describe, expect, it } from "vitest";

import { approvalDecisionProvenance } from "@/shared/ai/approvalDecisionPresentation";
import type { ApprovalDisplayRow } from "@/shared/ai/approvalRequests";

function approval(
  overrides: Partial<ApprovalDisplayRow>,
): ApprovalDisplayRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    salon_id: "22222222-2222-4222-8222-222222222222",
    action_type: "prepare_reengagement_audience",
    summary: "Prepare an audience",
    payload: {},
    urgency: "normal",
    status: "approved",
    expires_at: "2099-01-01T00:00:00.000Z",
    notified_at: null,
    reminded_at: null,
    decision_channel: "dashboard",
    decision_actor: {
      label: "owner@example.com",
      role: "owner",
    },
    decided_at: "2026-07-30T00:00:00.000Z",
    created_at: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("approvalDecisionProvenance", () => {
  it("names an authenticated dashboard actor and role", () => {
    expect(approvalDecisionProvenance(approval({}), "vi")).toEqual({
      channel: "Dashboard",
      actor: "owner@example.com · Chủ tiệm",
    });
  });

  it("does not claim identity attribution for an email capability", () => {
    expect(
      approvalDecisionProvenance(
        approval({
          decision_channel: "email_capability",
          decision_actor: null,
        }),
        "en",
      ),
    ).toEqual({
      channel: "Secure email link",
      actor: "Link signer is not identity-attributed",
    });
  });

  it("labels expiry as automation rather than a human decision", () => {
    expect(
      approvalDecisionProvenance(
        approval({
          status: "expired",
          decision_channel: null,
          decision_actor: null,
          decided_at: null,
        }),
        "vi",
      ),
    ).toEqual({
      channel: "Hệ thống tự động",
      actor: "Không có người quyết định",
    });
  });
});
