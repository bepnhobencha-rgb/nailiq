import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  analyzeAgentOutcomes,
  analyzeChannelFailures,
  createServiceRoleClient,
  getChannelCostSummary,
  insert,
  processExpiredAndRemind,
  select,
} = vi.hoisted(() => ({
  analyzeAgentOutcomes: vi.fn(),
  analyzeChannelFailures: vi.fn(),
  createServiceRoleClient: vi.fn(),
  getChannelCostSummary: vi.fn(),
  insert: vi.fn(),
  processExpiredAndRemind: vi.fn(),
  select: vi.fn(),
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient,
}));
vi.mock("@/shared/ai/analyzeChannelFailures", () => ({
  analyzeChannelFailures,
}));
vi.mock("@/shared/ai/analyzeOutcomes", () => ({
  analyzeAgentOutcomes,
}));
vi.mock("@/shared/ai/channelCostTracker", () => ({
  getChannelCostSummary,
}));
vi.mock("@/shared/ai/approvalRequests", () => ({
  processExpiredAndRemind,
}));

import { GET } from "./route";

const operationalTenant = {
  archived_at: null,
  superadmin_locked_at: null,
  subscription_status: "active",
};

describe("Minh learning cron route", () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    analyzeAgentOutcomes.mockReset();
    analyzeChannelFailures.mockReset();
    createServiceRoleClient.mockReset();
    getChannelCostSummary.mockReset();
    insert.mockReset();
    processExpiredAndRemind.mockReset();
    select.mockReset();

    createServiceRoleClient.mockReturnValue({
      from: vi.fn((table: string) =>
        table === "salons" ? { select } : { insert },
      ),
    });
    analyzeChannelFailures.mockResolvedValue({
      smsFailRate: 0,
      lessonCreated: false,
      lessonId: null,
    });
    analyzeAgentOutcomes.mockResolvedValue({
      agentStats: {},
      lessonsAdjusted: 0,
      adaptationsActivated: 0,
      adaptationsRecovered: 0,
    });
    getChannelCostSummary.mockResolvedValue({
      smsSent: 0,
      emailSent: 0,
      estimatedSmsUsdCents: 0,
      estimatedEmailUsdCents: 0,
    });
    processExpiredAndRemind.mockResolvedValue({ expired: 0, reminded: 0 });
    insert.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  it("fails closed when CRON_SECRET is missing", async () => {
    delete process.env.CRON_SECRET;

    const response = await GET(
      new Request("https://nailiq.ca/api/cron/minh-learn"),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "cron_secret_not_configured",
    });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer token", async () => {
    process.env.CRON_SECRET = "correct-secret";

    const response = await GET(
      new Request("https://nailiq.ca/api/cron/minh-learn", {
        headers: { authorization: "Bearer wrong-secret" },
      }),
    );

    expect(response.status).toBe(401);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("runs only for operational tenants with an AI feature enabled", async () => {
    process.env.CRON_SECRET = "correct-secret";
    select.mockResolvedValue({
      data: [
        {
          ...operationalTenant,
          id: "active",
          slug: "active",
          feature_flags: { ai_watchdog: true },
        },
        {
          ...operationalTenant,
          id: "canceled",
          slug: "canceled",
          feature_flags: { ai_watchdog: true },
          subscription_status: "canceled",
        },
        {
          ...operationalTenant,
          id: "archived",
          slug: "archived",
          feature_flags: { ai_watchdog: true },
          archived_at: "2026-07-28T12:00:00.000Z",
        },
        {
          ...operationalTenant,
          id: "locked",
          slug: "locked",
          feature_flags: { ai_watchdog: true },
          superadmin_locked_at: "2026-07-28T12:00:00.000Z",
        },
      ],
      error: null,
    });

    const response = await GET(
      new Request("https://nailiq.ca/api/cron/minh-learn", {
        headers: { authorization: "Bearer correct-secret" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      processed: 1,
      agentFailures: 0,
      results: [{ salon: "active" }],
    });
    expect(analyzeChannelFailures).toHaveBeenCalledTimes(1);
    expect(analyzeChannelFailures).toHaveBeenCalledWith("active");
    expect(analyzeAgentOutcomes).toHaveBeenCalledWith("active");
    expect(getChannelCostSummary).toHaveBeenCalledWith("active");
  });

  it("does not return database provider details when tenant loading fails", async () => {
    process.env.CRON_SECRET = "correct-secret";
    select.mockResolvedValue({
      data: null,
      error: { message: "sensitive database provider detail" },
    });

    const response = await GET(
      new Request("https://nailiq.ca/api/cron/minh-learn", {
        headers: { authorization: "Bearer correct-secret" },
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: "salon_load_failed",
    });
  });

  it("fails honestly without returning a raw provider error", async () => {
    process.env.CRON_SECRET = "correct-secret";
    select.mockResolvedValue({
      data: [
        {
          ...operationalTenant,
          id: "active",
          slug: "active",
          feature_flags: { ai_watchdog: true },
        },
      ],
      error: null,
    });
    analyzeChannelFailures.mockRejectedValue(
      new Error("provider secret must not reach the response"),
    );

    const response = await GET(
      new Request("https://nailiq.ca/api/cron/minh-learn", {
        headers: { authorization: "Bearer correct-secret" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      ok: false,
      processed: 1,
      agentFailures: 1,
      results: [{ salon: "active", channel_failures: "failed" }],
    });
    expect(JSON.stringify(body)).not.toContain("provider secret");
  });
});
