import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  recentGte: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/integrations/square/looseDb", () => ({
  looseServiceClient: () => ({
    rpc: mocks.rpc,
    from: () => ({
      select: () => ({
        eq: () => ({ gte: mocks.recentGte }),
      }),
    }),
  }),
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: vi.fn(),
}));
vi.mock("@/shared/lib/twilioSms", () => ({ sendSmsReminder: vi.fn() }));
vi.mock("@/shared/lib/resend", () => ({
  getResendClient: vi.fn(),
  getResendFrom: vi.fn(),
}));
vi.mock("@/shared/lib/emailCompliance", () => ({
  listUnsubscribeHeaders: vi.fn(),
  complianceFooterHtml: vi.fn(),
  isEmailSuppressed: vi.fn(),
}));
vi.mock("@/shared/ai/sendOwnerAlert", () => ({ sendOwnerAlert: vi.fn() }));
vi.mock("@/shared/ai/lessons", () => ({
  applyLearnedAgentCap: vi.fn(),
  getLessons: vi.fn(),
}));
vi.mock("@/shared/lib/channelResolver", () => ({
  resolveCustomerChannel: vi.fn(),
}));
vi.mock("@/shared/ai/agentPermissionFence", () => ({
  isAiAgentPermissionEnabled: vi.fn(),
}));
vi.mock("@/shared/ai/usageLedger", () => ({
  trackAnthropicMessage: vi.fn(),
}));

import { gatherRebookCandidates } from "@/shared/winback/agentRebook";

describe("Rebook candidate boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails visibly when the candidate RPC fails", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "function unavailable" },
    });

    await expect(gatherRebookCandidates("salon-1", 3)).rejects.toThrow(
      "rebook candidates query failed [PGRST202]: function unavailable",
    );
    expect(mocks.recentGte).not.toHaveBeenCalled();
  });

  it("fails visibly when the 30-day dedupe query fails", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          client_phone: "+15550000001",
          client_name: "Test Customer",
          client_email: "test@example.com",
          visits: 4,
          last_visit: "2026-07-01",
          cadence_days: 28,
          predicted_next: "2026-07-29",
          usual_service: "Manicure",
        },
      ],
      error: null,
    });
    mocks.recentGte.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "permission denied" },
    });

    await expect(gatherRebookCandidates("salon-1", 3)).rejects.toThrow(
      "rebook dedupe query failed [42501]: permission denied",
    );
  });

  it("returns only eligible rows not suggested in the last 30 days", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          client_phone: "+15550000001",
          client_name: "Already Suggested",
          client_email: "old@example.com",
          visits: 5,
          last_visit: "2026-07-01",
          cadence_days: 28,
          predicted_next: "2026-07-29",
          usual_service: "Manicure",
        },
        {
          client_phone: "+15550000002",
          client_name: "Eligible Customer",
          client_email: "eligible@example.com",
          visits: 4,
          last_visit: "2026-07-03",
          cadence_days: 30,
          predicted_next: "2026-08-02",
          usual_service: "Pedicure",
        },
      ],
      error: null,
    });
    mocks.recentGte.mockResolvedValue({
      data: [{ client_phone: "+15550000001" }],
      error: null,
    });

    await expect(gatherRebookCandidates("salon-1", 3)).resolves.toEqual([
      expect.objectContaining({
        phone: "+15550000002",
        name: "Eligible Customer",
        visits: 4,
      }),
    ]);
  });
});
