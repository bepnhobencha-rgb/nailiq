import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ constructor: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class AnthropicMock {
    constructor(options: unknown) {
      mocks.constructor(options);
    }
  },
}));

import {
  AI_TEXT_BACKGROUND_SDK_MAX_RETRIES,
  AI_TEXT_BACKGROUND_TIMEOUT_MS,
  createTextBackgroundAnthropicClient,
} from "@/shared/ai/anthropicProviderPolicy";

describe("Anthropic text/background provider policy", () => {
  it("uses the approved 20 second deadline with no implicit SDK retry", () => {
    createTextBackgroundAnthropicClient("qa-key");

    expect(AI_TEXT_BACKGROUND_TIMEOUT_MS).toBe(20_000);
    expect(AI_TEXT_BACKGROUND_SDK_MAX_RETRIES).toBe(0);
    expect(mocks.constructor).toHaveBeenCalledWith({
      apiKey: "qa-key",
      timeout: 20_000,
      maxRetries: 0,
    });
  });
});
