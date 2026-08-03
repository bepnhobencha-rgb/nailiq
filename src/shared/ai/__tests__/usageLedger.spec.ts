import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  estimateAnthropicCostUsd,
  normalizeAnthropicUsage,
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
});
