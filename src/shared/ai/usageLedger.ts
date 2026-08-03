import "server-only";

import type Anthropic from "@anthropic-ai/sdk";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

type AnthropicUsage = Anthropic.Messages.Usage;

type AnthropicPrice = {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
};

// Pricing snapshot: 2026-08-03, USD per 1M tokens. Unknown models remain
// observable but deliberately have a null estimate instead of a guessed cost.
const ANTHROPIC_PRICES: Readonly<Record<string, AnthropicPrice>> = {
  "claude-haiku-4-5-20251001": {
    inputPerMillion: 1,
    outputPerMillion: 5,
    cacheReadPerMillion: 0.1,
    cacheWritePerMillion: 1.25,
  },
  "claude-sonnet-4-5": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  "claude-sonnet-4-6": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
};

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

export type NormalizedAnthropicUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

export function normalizeAnthropicUsage(
  usage: AnthropicUsage,
): NormalizedAnthropicUsage {
  const extended = usage as AnthropicUsage & {
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  return {
    inputTokens: nonNegativeInteger(usage.input_tokens),
    outputTokens: nonNegativeInteger(usage.output_tokens),
    cacheReadInputTokens: nonNegativeInteger(
      extended.cache_read_input_tokens,
    ),
    cacheCreationInputTokens: nonNegativeInteger(
      extended.cache_creation_input_tokens,
    ),
  };
}

export function estimateAnthropicCostUsd(
  model: string,
  usage: NormalizedAnthropicUsage,
): number | null {
  const price = ANTHROPIC_PRICES[model];
  if (!price) return null;
  const cost =
    usage.inputTokens * price.inputPerMillion +
    usage.outputTokens * price.outputPerMillion +
    usage.cacheReadInputTokens * price.cacheReadPerMillion +
    usage.cacheCreationInputTokens * price.cacheWritePerMillion;
  return Number((cost / 1_000_000).toFixed(6));
}

function safeErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown_error";
  const candidate = error as { status?: unknown; name?: unknown };
  if (typeof candidate.status === "number") return `http_${candidate.status}`;
  if (typeof candidate.name === "string" && candidate.name.trim()) {
    return candidate.name.trim().slice(0, 120);
  }
  return "unknown_error";
}

async function writeUsageEvent(row: Record<string, unknown>): Promise<void> {
  try {
    const db = createServiceRoleClient();
    const { error } = await db.from("ai_usage_events" as never).insert(row as never);
    if (error) console.warn("[ai-usage] telemetry insert failed", error.code);
  } catch (error) {
    console.warn("[ai-usage] telemetry unavailable", safeErrorCode(error));
  }
}

export async function trackAnthropicMessage<T extends { usage: AnthropicUsage }>(
  context: {
    salonId: string | null;
    feature: string;
    model: string;
  },
  execute: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const response = await execute();
    const usage = normalizeAnthropicUsage(response.usage);
    await writeUsageEvent({
      salon_id: context.salonId,
      provider: "anthropic",
      feature: context.feature,
      model: context.model,
      status: "succeeded",
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadInputTokens,
      cache_creation_input_tokens: usage.cacheCreationInputTokens,
      estimated_cost_usd: estimateAnthropicCostUsd(context.model, usage),
      latency_ms: Math.max(0, Date.now() - startedAt),
      error_code: null,
    });
    return response;
  } catch (error) {
    await writeUsageEvent({
      salon_id: context.salonId,
      provider: "anthropic",
      feature: context.feature,
      model: context.model,
      status: "failed",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      estimated_cost_usd: null,
      latency_ms: Math.max(0, Date.now() - startedAt),
      error_code: safeErrorCode(error),
    });
    throw error;
  }
}
