import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
  executeVoiceTool: vi.fn(),
  rate: vi.fn().mockResolvedValue("allowed"),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/security/publicServerActionRateLimit", () => ({
  consumeDurableRateLimitBuckets: mocks.rate,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));
vi.mock("@/shared/voiceai/toolExecutor", () => ({
  executeVoiceTool: mocks.executeVoiceTool,
  logVoiceToolCall: vi.fn(),
}));

import { POST } from "@/app/api/voice/tool/route";

describe("browser Voice mutation boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rate.mockResolvedValue("allowed");
  });

  it.each([
    ["limited", 429],
    ["unavailable", 503],
  ] as const)("fails closed on %s limiter before DB/provider work", async (result, status) => {
    mocks.rate.mockResolvedValueOnce(result);
    const response = await POST(new NextRequest("https://nailiq.ca/api/voice/tool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toolName: "list_services", salonSlug: "qa-salon" }),
    }));
    expect(response.status).toBe(status);
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
    expect(mocks.executeVoiceTool).not.toHaveBeenCalled();
  });

  it.each(["confirm_booking", "confirm_group_booking"])(
    "rejects untrusted %s before constructing a DB client",
    async (toolName) => {
      const response = await POST(new NextRequest("https://nailiq.ca/api/voice/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolName, toolArgs: {}, salonSlug: "qa-salon" }),
      }));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "web_booking_handoff_required",
        booking_created: false,
      });
      expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
      expect(mocks.executeVoiceTool).not.toHaveBeenCalled();
    },
  );
});
