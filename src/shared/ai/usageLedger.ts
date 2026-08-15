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

type OpenAITextPrice = {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
};

// Pricing snapshot: 2026-08-13, USD per 1M tokens.
// Source: https://openai.com/api/pricing/ and the pinned model catalog.
const OPENAI_TEXT_PRICES: Readonly<Record<string, OpenAITextPrice>> = {
  "gpt-5.6-sol": {
    inputPerMillion: 5,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 30,
  },
  "gpt-5.6-terra": {
    inputPerMillion: 2.5,
    cachedInputPerMillion: 0.25,
    outputPerMillion: 15,
  },
  "gpt-5.6-luna": {
    inputPerMillion: 1,
    cachedInputPerMillion: 0.1,
    outputPerMillion: 6,
  },
};

const GPT_IMAGE_2_PRICE = {
  imageInputPerMillion: 8,
  textInputPerMillion: 5,
  imageOutputPerMillion: 30,
  textOutputPerMillion: 10,
} as const;

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

export type NormalizedOpenAIUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  inputTextTokens: number;
  inputImageTokens: number;
  outputTextTokens: number;
  outputImageTokens: number;
  hasModalityBreakdown: boolean;
};

export function normalizeOpenAIUsage(value: unknown): NormalizedOpenAIUsage {
  const usage = value && typeof value === "object"
    ? value as {
        input_tokens?: unknown;
        output_tokens?: unknown;
        input_tokens_details?: unknown;
        output_tokens_details?: unknown;
      }
    : {};
  const inputDetails = usage.input_tokens_details
    && typeof usage.input_tokens_details === "object"
    ? usage.input_tokens_details as {
        cached_tokens?: unknown;
        text_tokens?: unknown;
        image_tokens?: unknown;
      }
    : {};
  const outputDetails = usage.output_tokens_details
    && typeof usage.output_tokens_details === "object"
    ? usage.output_tokens_details as {
        text_tokens?: unknown;
        image_tokens?: unknown;
      }
    : {};
  const hasModalityBreakdown =
    typeof inputDetails.text_tokens === "number"
    && typeof inputDetails.image_tokens === "number";

  return {
    inputTokens: nonNegativeInteger(usage.input_tokens),
    outputTokens: nonNegativeInteger(usage.output_tokens),
    cachedInputTokens: nonNegativeInteger(inputDetails.cached_tokens),
    inputTextTokens: nonNegativeInteger(inputDetails.text_tokens),
    inputImageTokens: nonNegativeInteger(inputDetails.image_tokens),
    outputTextTokens: nonNegativeInteger(outputDetails.text_tokens),
    outputImageTokens: nonNegativeInteger(outputDetails.image_tokens),
    hasModalityBreakdown,
  };
}

export function estimateOpenAICostUsd(
  model: string,
  usage: NormalizedOpenAIUsage,
): number | null {
  const normalizedModel = model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (normalizedModel === "gpt-image-2") {
    if (!usage.hasModalityBreakdown) return null;
    const detailedOutput = usage.outputImageTokens + usage.outputTextTokens;
    const outputImageTokens = detailedOutput > 0
      ? usage.outputImageTokens
      : usage.outputTokens;
    const cost =
      usage.inputImageTokens * GPT_IMAGE_2_PRICE.imageInputPerMillion
      + usage.inputTextTokens * GPT_IMAGE_2_PRICE.textInputPerMillion
      + outputImageTokens * GPT_IMAGE_2_PRICE.imageOutputPerMillion
      + usage.outputTextTokens * GPT_IMAGE_2_PRICE.textOutputPerMillion;
    return Number((cost / 1_000_000).toFixed(6));
  }

  const price = OPENAI_TEXT_PRICES[normalizedModel];
  if (!price) return null;
  const cached = Math.min(usage.inputTokens, usage.cachedInputTokens);
  const uncached = usage.inputTokens - cached;
  const cost =
    uncached * price.inputPerMillion
    + cached * price.cachedInputPerMillion
    + usage.outputTokens * price.outputPerMillion;
  return Number((cost / 1_000_000).toFixed(6));
}

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

export async function recordOpenAIUsageEvent(input: {
  context: {
    salonId: string | null;
    correlationId?: string | null;
    feature: string;
    model: string;
  };
  status: "succeeded" | "failed";
  usage?: unknown;
  startedAt: number;
  errorCode?: string | null;
}): Promise<void> {
  const usage = normalizeOpenAIUsage(input.usage);
  await writeUsageEvent({
    salon_id: input.context.salonId,
    correlation_id: input.context.correlationId ?? null,
    provider: "openai",
    feature: input.context.feature,
    model: input.context.model,
    status: input.status,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: usage.cachedInputTokens,
    cache_creation_input_tokens: 0,
    estimated_cost_usd: input.status === "succeeded"
      ? estimateOpenAICostUsd(input.context.model, usage)
      : null,
    latency_ms: Math.max(0, Date.now() - input.startedAt),
    error_code: input.errorCode ?? null,
  });
}

async function writeAnthropicUsageEvent(input: {
  context: {
    salonId: string | null;
    feature: string;
    model: string;
  };
  status: "succeeded" | "failed";
  usage: NormalizedAnthropicUsage;
  startedAt: number;
  errorCode: string | null;
}): Promise<void> {
  await writeUsageEvent({
    salon_id: input.context.salonId,
    provider: "anthropic",
    feature: input.context.feature,
    model: input.context.model,
    status: input.status,
    input_tokens: input.usage.inputTokens,
    output_tokens: input.usage.outputTokens,
    cache_read_input_tokens: input.usage.cacheReadInputTokens,
    cache_creation_input_tokens: input.usage.cacheCreationInputTokens,
    estimated_cost_usd: estimateAnthropicCostUsd(
      input.context.model,
      input.usage,
    ),
    latency_ms: Math.max(0, Date.now() - input.startedAt),
    error_code: input.errorCode,
  });
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
    await writeAnthropicUsageEvent({
      context,
      status: "succeeded",
      usage,
      startedAt,
      errorCode: null,
    });
    return response;
  } catch (error) {
    await writeAnthropicUsageEvent({
      context,
      status: "failed",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      startedAt,
      errorCode: safeErrorCode(error),
    });
    throw error;
  }
}

export async function trackAnthropicStream(
  context: {
    salonId: string | null;
    feature: string;
    model: string;
  },
  execute: () => Promise<
    AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>
  >,
): Promise<AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>> {
  const startedAt = Date.now();
  let source: AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>;
  try {
    source = await execute();
  } catch (error) {
    await writeAnthropicUsageEvent({
      context,
      status: "failed",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      startedAt,
      errorCode: safeErrorCode(error),
    });
    throw error;
  }

  return {
    async *[Symbol.asyncIterator]() {
      let usage: NormalizedAnthropicUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      };
      let recorded = false;
      try {
        for await (const event of source) {
          if (event.type === "message_start") {
            usage = normalizeAnthropicUsage(event.message.usage);
          } else if (event.type === "message_delta") {
            usage = {
              inputTokens: nonNegativeInteger(
                event.usage.input_tokens ?? usage.inputTokens,
              ),
              outputTokens: nonNegativeInteger(event.usage.output_tokens),
              cacheReadInputTokens: nonNegativeInteger(
                event.usage.cache_read_input_tokens ??
                  usage.cacheReadInputTokens,
              ),
              cacheCreationInputTokens: nonNegativeInteger(
                event.usage.cache_creation_input_tokens ??
                  usage.cacheCreationInputTokens,
              ),
            };
          }
          yield event;
        }
        await writeAnthropicUsageEvent({
          context,
          status: "succeeded",
          usage,
          startedAt,
          errorCode: null,
        });
        recorded = true;
      } catch (error) {
        await writeAnthropicUsageEvent({
          context,
          status: "failed",
          usage,
          startedAt,
          errorCode: safeErrorCode(error),
        });
        recorded = true;
        throw error;
      } finally {
        if (!recorded) {
          await writeAnthropicUsageEvent({
            context,
            status: "failed",
            usage,
            startedAt,
            errorCode: "stream_cancelled",
          });
        }
      }
    },
  };
}

function normalizeAnthropicFetchUsage(
  value: unknown,
): NormalizedAnthropicUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = (value as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const counters = usage as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  };
  if (
    typeof counters.input_tokens !== "number" ||
    typeof counters.output_tokens !== "number"
  ) {
    return null;
  }
  return {
    inputTokens: nonNegativeInteger(counters.input_tokens),
    outputTokens: nonNegativeInteger(counters.output_tokens),
    cacheReadInputTokens: nonNegativeInteger(
      counters.cache_read_input_tokens,
    ),
    cacheCreationInputTokens: nonNegativeInteger(
      counters.cache_creation_input_tokens,
    ),
  };
}

export async function trackAnthropicFetch(
  context: {
    salonId: string | null;
    feature: string;
    model: string;
  },
  execute: () => Promise<Response>,
): Promise<Response> {
  const startedAt = Date.now();
  try {
    const response = await execute();
    let usage: NormalizedAnthropicUsage | null = null;
    if (response.ok) {
      try {
        usage = normalizeAnthropicFetchUsage(
          await response.clone().json(),
        );
      } catch {
        usage = null;
      }
    }
    await writeAnthropicUsageEvent({
      context,
      status: response.ok ? "succeeded" : "failed",
      usage: usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      startedAt,
      errorCode: response.ok
        ? usage
          ? null
          : "usage_unavailable"
        : `http_${response.status}`,
    });
    return response;
  } catch (error) {
    await writeAnthropicUsageEvent({
      context,
      status: "failed",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      startedAt,
      errorCode: safeErrorCode(error),
    });
    throw error;
  }
}
