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
  estimateOpenAICostUsd,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
  recordOpenAIUsageEvent,
  trackAnthropicFetch,
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

  it("estimates pinned GPT Image 2 cost from its modality breakdown", () => {
    const usage = normalizeOpenAIUsage({
      input_tokens: 1_100,
      output_tokens: 500,
      input_tokens_details: { image_tokens: 1_000, text_tokens: 100 },
      output_tokens_details: { image_tokens: 500, text_tokens: 0 },
    });

    expect(
      estimateOpenAICostUsd("gpt-image-2-2026-04-21", usage),
    ).toBe(0.0235);
  });

  it("estimates Luna usage with cached input at the pinned price", () => {
    const usage = normalizeOpenAIUsage({
      input_tokens: 1_000,
      output_tokens: 100,
      input_tokens_details: { cached_tokens: 200 },
    });

    expect(estimateOpenAICostUsd("gpt-5.6-luna", usage)).toBe(0.00142);
  });

  it("does not guess image cost without a modality breakdown", () => {
    expect(
      estimateOpenAICostUsd(
        "gpt-image-2",
        normalizeOpenAIUsage({ input_tokens: 100, output_tokens: 200 }),
      ),
    ).toBeNull();
  });

  it("records OpenAI usage with a PII-free session correlation key", async () => {
    mocks.insert.mockResolvedValueOnce({ error: null });

    await recordOpenAIUsageEvent({
      context: {
        salonId: "00000000-0000-4000-8000-000000000003",
        correlationId: "00000000-0000-4000-8000-000000000004",
        feature: "nail_tryon_generation",
        model: "gpt-image-2-2026-04-21",
      },
      status: "succeeded",
      usage: {
        input_tokens: 1_100,
        output_tokens: 500,
        input_tokens_details: { image_tokens: 1_000, text_tokens: 100 },
        output_tokens_details: { image_tokens: 500, text_tokens: 0 },
      },
      startedAt: Date.now(),
    });

    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        salon_id: "00000000-0000-4000-8000-000000000003",
        correlation_id: "00000000-0000-4000-8000-000000000004",
        provider: "openai",
        feature: "nail_tryon_generation",
        model: "gpt-image-2-2026-04-21",
        status: "succeeded",
        input_tokens: 1_100,
        output_tokens: 500,
        estimated_cost_usd: 0.0235,
        error_code: null,
      }),
    );
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

  it("tracks raw-fetch usage without consuming the feature response body", async () => {
    mocks.insert.mockResolvedValueOnce({ error: null });
    const payload = {
      content: [{ type: "text", text: "feature output" }],
      usage: {
        input_tokens: 500,
        output_tokens: 25,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
      },
    };
    const response = await trackAnthropicFetch(
      {
        salonId: "00000000-0000-4000-8000-000000000002",
        feature: "client_360_summary",
        model: "claude-haiku-4-5-20251001",
      },
      async () => Response.json(payload),
    );

    await expect(response.json()).resolves.toEqual(payload);
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        salon_id: "00000000-0000-4000-8000-000000000002",
        feature: "client_360_summary",
        status: "succeeded",
        input_tokens: 500,
        output_tokens: 25,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
        estimated_cost_usd: 0.000697,
        error_code: null,
      }),
    );
  });

  it("records a safe HTTP failure while preserving the response", async () => {
    mocks.insert.mockResolvedValueOnce({ error: null });
    const response = await trackAnthropicFetch(
      {
        salonId: null,
        feature: "service_description",
        model: "claude-haiku-4-5-20251001",
      },
      async () => new Response("provider unavailable", { status: 503 }),
    );

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe("provider unavailable");
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        input_tokens: 0,
        output_tokens: 0,
        error_code: "http_503",
      }),
    );
  });
});
