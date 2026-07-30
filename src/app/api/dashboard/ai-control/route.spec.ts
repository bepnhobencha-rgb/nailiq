import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  decideApproval: vi.fn(),
  controlException: vi.fn(),
  controlJob: vi.fn(),
  prepareAudience: vi.fn(),
  preflightCampaign: vi.fn(),
  sealCampaign: vi.fn(),
}));

vi.mock("@/shared/ai/decideApprovalAction", () => ({
  decideApprovalAction: actions.decideApproval,
}));
vi.mock("@/shared/ai/controlOperationalExceptionAction", () => ({
  controlOperationalExceptionAction: actions.controlException,
}));
vi.mock("@/shared/ai/controlExecutionJobAction", () => ({
  controlExecutionJobAction: actions.controlJob,
}));
vi.mock("@/shared/ai/prepareAudienceAction", () => ({
  prepareAudienceAction: actions.prepareAudience,
}));
vi.mock("@/shared/ai/preflightCampaignAction", () => ({
  preflightCampaignAction: actions.preflightCampaign,
}));
vi.mock("@/shared/ai/sealCampaignPlanAction", () => ({
  sealCampaignPlanAction: actions.sealCampaign,
}));

import { POST } from "@/app/api/dashboard/ai-control/route";

const UUID = "11111111-1111-4111-8111-111111111111";

function request(
  body: Record<string, unknown>,
  origin = "https://nailiq.ca",
) {
  return new NextRequest("https://nailiq.ca/api/dashboard/ai-control", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify(body),
  });
}

describe("AI Control API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actions.decideApproval.mockResolvedValue({
      ok: true,
      status: "approved",
    });
  });

  it("rejects cross-origin mutation requests before invoking an action", async () => {
    const response = await POST(
      request(
        {
          slug: "hoa-hong",
          action: "decide_approval",
          approvalId: UUID,
          decision: "approved",
        },
        "https://attacker.example",
      ),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "invalid_origin",
    });
    expect(actions.decideApproval).not.toHaveBeenCalled();
  });

  it("validates identifiers before invoking an action", async () => {
    const response = await POST(
      request({
        slug: "hoa-hong",
        action: "control_job",
        jobId: "not-an-id",
        operation: "retry",
      }),
    );

    expect(response.status).toBe(400);
    expect(actions.controlJob).not.toHaveBeenCalled();
  });

  it("dispatches a same-origin approval decision with tenant context", async () => {
    const response = await POST(
      request({
        slug: "hoa-hong",
        action: "decide_approval",
        approvalId: UUID,
        decision: "approved",
      }),
    );

    expect(response.status).toBe(200);
    expect(actions.decideApproval).toHaveBeenCalledWith({
      slug: "hoa-hong",
      approvalId: UUID,
      decision: "approved",
    });
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: "approved",
    });
  });

  it("preserves authorization failures from the server action boundary", async () => {
    actions.decideApproval.mockResolvedValueOnce({
      ok: false,
      error: "forbidden",
    });
    const response = await POST(
      request({
        slug: "hoa-hong",
        action: "decide_approval",
        approvalId: UUID,
        decision: "declined",
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "forbidden",
    });
  });
});
