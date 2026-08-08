import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({
    from: () => ({ insert: mocks.insert }),
  }),
}));
import {
  estimateAnthropicCostUsd,
  normalizeAnthropicUsage,
  trackAnthropicStream,
} from "@/shared/ai/usageLedger";

describe("AI usage ledger", () => {
  it("normalizes Anthropic token counters without negative values", () => {
    expect(
      normalizeAnthropicUsage({
        input_tokens: 1_000,
        output_tokens: 200,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: -2,
      } as never),
    ).toEqual({
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadInputTokens: 500,
      cacheCreationInputTokens: 0,
    });
  });

  it("estimates pinned Haiku cost from the documented pricing snapshot", () => {
    expect(
      estimateAnthropicCostUsd("claude-haiku-4-5-20251001", {
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadInputTokens: 500,
        cacheCreationInputTokens: 0,
      }),
    ).toBe(0.00205);
  });

  it("does not guess a price for an unknown model", () => {
    expect(
      estimateAnthropicCostUsd("future-model", {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      }),
    ).toBeNull();
  });

  it("records cumulative usage after a streaming response completes", async () => {
    mocks.insert.mockResolvedValueOnce({ error: null });
    const events = [
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 1_000,
            output_tokens: 0,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 100,
          },
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello" },
      },
      {
        type: "message_delta",
        delta: {},
        usage: {
          input_tokens: 1_000,
          output_tokens: 40,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 100,
        },
      },
      { type: "message_stop" },
    ];
    const tracked = await trackAnthropicStream(
      {
        salonId: "00000000-0000-4000-8000-000000000001",
        feature: "booking_chat",
        model: "claude-haiku-4-5-20251001",
      },
      async () => ({
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event as never;
        },
      }),
    );

    const observed = [];
    for await (const event of tracked) observed.push(event.type);

    expect(observed).toEqual(events.map((event) => event.type));
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        salon_id: "00000000-0000-4000-8000-000000000001",
        feature: "booking_chat",
        status: "succeeded",
        input_tokens: 1_000,
        output_tokens: 40,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 100,
        estimated_cost_usd: 0.001345,
        error_code: null,
      }),
    );
  });

  it("records a bounded failure when the stream consumer cancels", async () => {
    mocks.insert.mockResolvedValueOnce({ error: null });
    const tracked = await trackAnthropicStream(
      {
        salonId: null,
        feature: "booking_chat",
        model: "claude-haiku-4-5-20251001",
      },
      async () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "message_start",
            message: {
              usage: {
                input_tokens: 10,
                output_tokens: 0,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            },
          } as never;
          yield { type: "message_stop" } as never;
        },
      }),
    );

    for await (const event of tracked) {
      expect(event.type).toBe("message_start");
      break;
    }

    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        input_tokens: 10,
        output_tokens: 0,
        error_code: "stream_cancelled",
      }),
    );
  });
});
