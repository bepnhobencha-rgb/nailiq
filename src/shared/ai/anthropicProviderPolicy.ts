import "server-only";

import Anthropic from "@anthropic-ai/sdk";

/**
 * Approved timeout boundary for non-streaming text/background Anthropic work.
 * Streaming requests and Nail Try-On deliberately use their own policies.
 */
export const AI_TEXT_BACKGROUND_TIMEOUT_MS = 20_000;
export const AI_TEXT_BACKGROUND_SDK_MAX_RETRIES = 0;

export function createTextBackgroundAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    timeout: AI_TEXT_BACKGROUND_TIMEOUT_MS,
    maxRetries: AI_TEXT_BACKGROUND_SDK_MAX_RETRIES,
  });
}
