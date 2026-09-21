import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  rpc: vi.fn(),
  generate: vi.fn(),
  send: vi.fn(),
  claim: vi.fn(),
  getResendClient: vi.fn(),
  outcomeStats: vi.fn(),
  pendingApprovals: vi.fn(),
  unclosedBookings: vi.fn(),
  flags: {} as Record<string, unknown>,
  settings: {} as Record<string, unknown>,
  errors: {} as Record<string, { message: string }>,
  missingData: "",
  missingSalon: false,
  alreadySent: false,
  actions: [] as Array<Record<string, unknown>>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/ai/anthropicProviderPolicy", () => ({
  createTextBackgroundAnthropicClient: () => ({ messages: { create: mocks.generate } }),
}));
vi.mock("@/shared/ai/usageLedger", () => ({
  trackAnthropicMessage: (_context: unknown, execute: () => Promise<unknown>) => execute(),
}));
vi.mock("@/shared/ai/executionLimit", () => ({
  claimAiExecutionSlot: mocks.claim,
  ruleFirstOptimizationEnabled: (flags: Record<string, unknown>) =>
    flags.ai_rule_first_optimization === true,
}));
vi.mock("@/shared/ai/agentOutcomeTracker", () => ({
  getOutcomeStats: mocks.outcomeStats,
}));
vi.mock("@/shared/ai/approvalRequests", () => ({
  getPendingApprovals: mocks.pendingApprovals,
  approvalAllowsEmail: () => true,
}));
vi.mock("@/shared/dashboard/loadUnclosedBookings", () => ({
  loadUnclosedBookings: mocks.unclosedBookings,
}));
vi.mock("@/shared/lib/resend", () => ({
  getResendClient: mocks.getResendClient,
  getResendFrom: () => "NailIQ <noreply@example.com>",
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({
    rpc: mocks.rpc,
    from: (table: string) => {
      let columns = "";
      const chain: Record<string, unknown> = {};
      chain.select = (value: string) => {
        columns = value;
        return chain;
      };
      for (const method of ["eq", "gte", "lt", "not", "limit"]) {
        chain[method] = () => chain;
      }
      chain.maybeSingle = () => Promise.resolve(mocks.query(table, columns));
      chain.then = (
        resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown,
      ) => Promise.resolve(mocks.query(table, columns)).then(resolve, reject);
      return chain;
    },
  }),
}));

import { runDigest } from "@/shared/ai/agentDigest";

const SALON_ID = "22222222-2222-4222-8222-222222222222";
const AI_BODY = "Hôm nay tiệm hoàn thành hai lịch hẹn. Tôi đã soạn caption nháp để chủ tiệm duyệt. Ngày mai hiện có bốn lịch hẹn.";

function providerResponse(text = AI_BODY, stopReason = "end_turn") {
  return { stop_reason: stopReason, content: [{ type: "text", text }] };
}

function sentEmail(): { subject: string; text: string; html: string; to: string[] } {
  return mocks.send.mock.calls[0][0];
}

function expectRecordedDelivery() {
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.send.mock.calls[0][1]).toEqual({
    idempotencyKey: `nailiq-digest-${SALON_ID}-2026-09-20`,
  });
  expect(sentEmail().subject).toBe("Test Head Spa · Tổng kết 2026-09-20");
  expect(sentEmail().to).toEqual(["owner@example.com"]);
  expect(mocks.rpc).toHaveBeenCalledWith(
    "record_ai_digest_delivery",
    expect.objectContaining({
      p_salon_id: SALON_ID,
      p_digest_date: "2026-09-20",
      p_provider_message_id: "receipt-1",
      p_recipient_count: 1,
    }),
  );
}

describe("runDigest generation and delivery recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T04:00:00.000Z"));
    vi.stubEnv("ANTHROPIC_API_KEY", "mock-key-not-a-real-credential");
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("Network is forbidden in digest regression tests");
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.flags = { ai_unified_digest: true };
    mocks.settings = { enabled: true, digest_emails: ["OWNER@example.com"] };
    mocks.errors = {};
    mocks.missingData = "";
    mocks.missingSalon = false;
    mocks.alreadySent = false;
    mocks.actions = [{ agent: "social_content", action_type: "sent_social_draft", payload: {} }];
    mocks.generate.mockReset().mockResolvedValue(providerResponse());
    mocks.send.mockReset().mockResolvedValue({ data: { id: "receipt-1" }, error: null });
    mocks.rpc.mockReset().mockResolvedValue({ data: "delivery-1", error: null });
    mocks.claim.mockReset().mockResolvedValue(true);
    mocks.getResendClient.mockReturnValue({ emails: { send: mocks.send } });
    mocks.outcomeStats.mockResolvedValue([]);
    mocks.pendingApprovals.mockResolvedValue([]);
    mocks.unclosedBookings.mockResolvedValue({ count: 2, items: [] });
    mocks.query.mockImplementation((table: string, columns: string) => {
      let key: string;
      let data: unknown;
      let count: number | null = null;
      if (table === "salons" && columns === "owner_notification_settings") {
        key = "settings";
        data = { owner_notification_settings: mocks.settings };
      } else if (table === "salons") {
        key = "salon";
        data = mocks.missingSalon ? null : {
          name: "Test Head Spa",
          slug: "e2e-digest-test",
          timezone: "America/Los_Angeles",
          feature_flags: mocks.flags,
          ai_manager_instructions: "PRIVATE-INSTRUCTIONS-MUST-NOT-LEAK",
        };
      } else if (table === "ai_actions_log" && columns === "id") {
        key = "dedupe";
        data = mocks.alreadySent ? { id: "previous-delivery" } : null;
      } else if (table === "ai_actions_log") {
        key = "actions";
        data = mocks.actions;
      } else if (table === "watchdog_alerts") {
        key = "alerts";
        data = [];
      } else if (table === "bookings" && columns === "id") {
        key = "tomorrow";
        data = null;
        count = 4;
      } else if (table === "bookings") {
        key = "today";
        data = [
          { status: "completed", price_cents: 12_000 },
          { status: "completed", price_cents: 3_000 },
          { status: "no_show", price_cents: 2_000 },
        ];
      } else {
        throw new Error(`Unexpected table ${table}`);
      }
      return {
        data: mocks.errors[key] || mocks.missingData === key ? null : data,
        count: mocks.missingData === key ? null : count,
        error: mocks.errors[key] ?? null,
      };
    });
  });

  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([false, true])("sends and records valid AI prose with optimization=%s", async (optimized) => {
    mocks.flags.ai_rule_first_optimization = optimized;
    await expect(runDigest(SALON_ID)).resolves.toEqual({ status: "sent", bodySource: "ai" });
    expect(sentEmail().text).toContain(AI_BODY);
    expectRecordedDelivery();
  });

  describe.each([false, true])("AI recovery with optimization=%s", (optimized) => {
    it.each(["timeout", "provider error", "truncated", "short", "empty", "non-text"])(
      "sends an accurate fallback after %s",
      async (failure) => {
        mocks.flags.ai_rule_first_optimization = optimized;
        if (failure === "timeout") {
          mocks.generate.mockRejectedValue(Object.assign(new Error("timed out"), { name: "APIConnectionTimeoutError" }));
        } else if (failure === "provider error") {
          mocks.generate.mockRejectedValue(new Error("upstream failed"));
        } else if (failure === "truncated") {
          mocks.generate.mockResolvedValue(providerResponse("DO-NOT-SEND-TRUNCATED-PROSE".repeat(5), "max_tokens"));
        } else if (failure === "non-text") {
          mocks.generate.mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "tool_use", name: "unexpected" }] });
        } else {
          mocks.generate.mockResolvedValue(providerResponse(failure === "short" ? "Too short" : ""));
        }

        await expect(runDigest(SALON_ID)).resolves.toEqual({ status: "sent", bodySource: "deterministic" });
        const text = sentEmail().text;
        expect(text).toContain("2/3");
        expect(text).toContain("$150");
        expect(text).toContain("Ngày mai hiện có 4 lịch");
        expect(text).toContain("2 lịch hẹn cần chốt sổ");
        expect(text).toContain("chưa đăng nội dung lên mạng xã hội");
        expect(text).toContain("Hệ thống ghi nhận 1 khách không đến");
        expect(text).not.toContain("DO-NOT-SEND-TRUNCATED-PROSE");
        expect(text).not.toContain("PRIVATE-INSTRUCTIONS-MUST-NOT-LEAK");
        expectRecordedDelivery();
      },
    );
  });

  it.each([false, true])("uses a safe summary without an AI key with optimization=%s", async (optimized) => {
    mocks.flags.ai_rule_first_optimization = optimized;
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(runDigest(SALON_ID)).resolves.toEqual({ status: "sent", bodySource: "deterministic" });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(sentEmail().text).toContain("$150");
    expect(sentEmail().text).not.toContain("PRIVATE-INSTRUCTIONS-MUST-NOT-LEAK");
    expectRecordedDelivery();
  });

  it("uses a fallback after unsafe AI claims without mailing those claims", async () => {
    mocks.generate.mockResolvedValue(providerResponse("Tôi đã xuất bản một nội dung trên mạng xã hội cho tiệm hôm nay. Ngày mai sẽ tiếp tục chăm sóc khách hàng."));
    await expect(runDigest(SALON_ID)).resolves.toEqual({ status: "sent", bodySource: "deterministic" });
    expect(sentEmail().text).not.toContain("Tôi đã xuất bản");
    expectRecordedDelivery();
  });

  it("still sends a fallback when the optimized AI slot is unavailable", async () => {
    mocks.flags.ai_rule_first_optimization = true;
    mocks.claim.mockResolvedValue(false);
    await expect(runDigest(SALON_ID)).resolves.toEqual({ status: "sent", bodySource: "deterministic" });
    expect(mocks.generate).not.toHaveBeenCalled();
    expectRecordedDelivery();
  });

  it("retains pending approval controls and records their ids when AI fails", async () => {
    mocks.generate.mockRejectedValue(new Error("provider unavailable"));
    mocks.pendingApprovals.mockResolvedValue([{
      id: "approval-1",
      urgency: "normal",
      summary: "Review the service menu",
      approve_token: "mock-approve-token",
      decline_token: "mock-decline-token",
    }]);
    await expect(runDigest(SALON_ID)).resolves.toEqual({ status: "sent", bodySource: "deterministic" });
    expect(sentEmail().html).toContain("mock-approve-token");
    expect(sentEmail().html).toContain("mock-decline-token");
    expect(mocks.rpc).toHaveBeenCalledWith("record_ai_digest_delivery", expect.objectContaining({
      p_approval_ids: ["approval-1"],
    }));
  });

  it("reports the feature-disabled skip without generating or sending", async () => {
    mocks.flags.ai_unified_digest = false;
    await expect(runDigest(SALON_ID)).resolves.toEqual({ status: "skipped", reason: "feature_disabled" });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("preserves same-day deduplication without generating or sending again", async () => {
    mocks.alreadySent = true;
    await expect(runDigest(SALON_ID)).resolves.toEqual({ status: "skipped", reason: "already_sent" });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("reports notifications-disabled instead of claiming delivery", async () => {
    mocks.settings.enabled = false;
    await expect(runDigest(SALON_ID)).resolves.toEqual({ status: "skipped", reason: "notifications_disabled" });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("fails if the salon disappeared", async () => {
    mocks.missingSalon = true;
    await expect(runDigest(SALON_ID)).rejects.toThrow();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each(["salon", "dedupe", "today", "tomorrow", "actions", "alerts", "settings"])(
    "does not send fabricated or incomplete data after a %s read failure",
    async (query) => {
      mocks.errors[query] = { message: "database unavailable" };
      await expect(runDigest(SALON_ID)).rejects.toThrow();
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it.each(["today", "tomorrow"])("rejects a missing %s statistics result rather than assuming zero", async (query) => {
    mocks.missingData = query;
    await expect(runDigest(SALON_ID)).rejects.toThrow("digest_booking_stats_unavailable");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("does not resend after the first acknowledged email was recorded", async () => {
    mocks.rpc.mockImplementation(async () => {
      mocks.alreadySent = true;
      return { data: "delivery-1", error: null };
    });
    await expect(runDigest(SALON_ID)).resolves.toEqual({ status: "sent", bodySource: "ai" });
    await expect(runDigest(SALON_ID)).resolves.toEqual({ status: "skipped", reason: "already_sent" });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("does not record a delivery when Resend rejects the message", async () => {
    mocks.send.mockResolvedValue({ data: null, error: { message: "rejected" } });
    await expect(runDigest(SALON_ID)).rejects.toThrow();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([null, {}, { id: "" }, { id: "   " }])("does not record an unacknowledged provider response %j", async (data) => {
    mocks.send.mockResolvedValue({ data, error: null });
    await expect(runDigest(SALON_ID)).rejects.toThrow();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("reports failure when an accepted email cannot be durably recorded", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "ledger unavailable" } });
    await expect(runDigest(SALON_ID)).rejects.toThrow("digest_delivery_record_failed");
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});
