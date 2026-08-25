import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  createClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
  adminRpc: vi.fn(),
  executeVoiceTool: vi.fn(),
  loadSalonContext: vi.fn(),
  trackAnthropicMessage: vi.fn(),
  trackAnthropicStream: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class AnthropicMock {
    messages = { create: mocks.anthropicCreate };
  },
}));
vi.mock("@/shared/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));
vi.mock("@/shared/lib/inAppRateLimit", () => ({
  clientIp: () => "203.0.113.7",
}));
vi.mock("@/shared/voiceai/loadSalonContext", () => ({
  loadSalonContext: mocks.loadSalonContext,
}));
vi.mock("@/shared/voiceai/buildSystemPrompt", () => ({
  buildSystemPrompt: () => "shared booking brain",
}));
vi.mock("@/shared/voiceai/toolExecutor", () => ({
  executeVoiceTool: mocks.executeVoiceTool,
}));
vi.mock("@/shared/ai/usageLedger", () => ({
  trackAnthropicMessage: mocks.trackAnthropicMessage,
  trackAnthropicStream: mocks.trackAnthropicStream,
}));

import { POST } from "./route";

const salonId = "11111111-1111-4111-8111-111111111111";

function request(text = "Please find me a manicure tomorrow") {
  return new NextRequest("https://www.nailiq.ca/api/chat/booking", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      salonId,
      messages: [{ role: "user", content: text }],
    }),
  });
}

function installPublicRead() {
  mocks.createClient.mockResolvedValue({
    from: vi.fn((table: string) => {
      if (table === "salons") {
        const query = {
          select: vi.fn(() => query),
          eq: vi.fn(() => query),
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              name: "QA Salon",
              opening_hours: null,
              vertical: "nail_salon",
            },
          }),
        };
        return query;
      }
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        is: vi.fn(() => query),
        order: vi.fn(() => query),
        limit: vi.fn().mockResolvedValue({ data: [] }),
      };
      return query;
    }),
  });
}

function installAdminRead(enabled: boolean) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn().mockResolvedValue({
      data: {
        slug: "qa-salon",
        default_language: "en",
        feature_flags: { booking_chat_tools_enabled: enabled },
      },
    }),
  };
  mocks.createServiceRoleClient.mockReturnValue({
    from: vi.fn(() => query),
    rpc: mocks.adminRpc,
  });
}

describe("public booking chat transactional boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key";
    mocks.adminRpc.mockResolvedValue({ data: true, error: null });
    mocks.trackAnthropicMessage.mockImplementation(
      async (_meta: unknown, call: () => Promise<unknown>) => call(),
    );
    mocks.trackAnthropicStream.mockImplementation(
      async (_meta: unknown, call: () => Promise<unknown>) => call(),
    );
    installPublicRead();
    installAdminRead(false);
    mocks.loadSalonContext.mockResolvedValue({ salonId, salonName: "QA Salon" });
  });

  it("returns 429 before any model call when a durable limit is hit", async () => {
    installAdminRead(true);
    mocks.adminRpc
      .mockResolvedValueOnce({ data: false, error: null })
      .mockResolvedValueOnce({ data: true, error: null });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
    expect(mocks.executeVoiceTool).not.toHaveBeenCalled();
  });

  it("fails closed before model spend when the durable limiter is unavailable", async () => {
    installAdminRead(true);
    mocks.adminRpc
      .mockResolvedValueOnce({ data: null, error: { message: "db unavailable" } })
      .mockResolvedValueOnce({ data: true, error: null });

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
    expect(mocks.executeVoiceTool).not.toHaveBeenCalled();
  });

  it("keeps transactional tools default-off", async () => {
    installAdminRead(false);
    mocks.anthropicCreate.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { type: "content_block_delta", delta: { type: "text_delta", text: "Use the form." } };
      },
    });

    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Use the form.");
    expect(mocks.adminRpc).not.toHaveBeenCalled();
    expect(mocks.executeVoiceTool).not.toHaveBeenCalled();
  });

  it("uses the shared executor only after the explicit pilot flag is on", async () => {
    installAdminRead(true);
    mocks.executeVoiceTool.mockResolvedValue(
      Response.json({ success: true, slots: ["14:00"] }),
    );
    mocks.anthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          id: "tool-1",
          name: "get_available_slots",
          input: { date: "2026-08-13" },
        }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "2:00 PM is available." }],
      });

    const response = await POST(request());
    const firstModelCall = mocks.anthropicCreate.mock.calls[0]?.[0] as {
      tools: Array<{ name: string }>;
    };

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("2:00 PM is available.");
    expect(mocks.executeVoiceTool).toHaveBeenCalledWith(
      expect.anything(),
      "qa-salon",
      "get_available_slots",
      { date: "2026-08-13" },
      null,
      "https://www.nailiq.ca",
    );
    expect(firstModelCall.tools.map((tool) => tool.name)).toContain("confirm_booking");
    expect(firstModelCall.tools.map((tool) => tool.name)).not.toContain("transfer_to_human");
    expect(firstModelCall.tools.map((tool) => tool.name)).not.toContain("leave_message_for_owner");
  });

  it("refuses a phone-only tool even if a provider response names it", async () => {
    installAdminRead(true);
    mocks.anthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          id: "tool-unsafe",
          name: "transfer_to_human",
          input: { reason: "ignored" },
        }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Please use the booking form." }],
      });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.executeVoiceTool).not.toHaveBeenCalled();
  });
});
