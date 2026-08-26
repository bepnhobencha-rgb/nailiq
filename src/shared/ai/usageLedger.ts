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

export function safeErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown_error";
  const candidate = error as {
    status?: unknown;
    name?: unknown;
    code?: unknown;
    cause?: unknown;
  };
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const code = typeof candidate.code === "string" ? candidate.code.trim() : "";
  const cause =
    candidate.cause && typeof candidate.cause === "object"
      ? (candidate.cause as { name?: unknown; code?: unknown })
      : null;
  const causeName = typeof cause?.name === "string" ? cause.name.trim() : "";
  const causeCode = typeof cause?.code === "string" ? cause.code.trim() : "";
  if (
    candidate.status === 408 ||
    name === "APIConnectionTimeoutError" ||
    name === "TimeoutError" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    causeName === "ConnectTimeoutError" ||
    causeCode === "ETIMEDOUT" ||
    causeCode === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return "provider_timeout";
  }
  if (typeof candidate.status === "number") return `http_${candidate.status}`;
  if (name) {
    return name.slice(0, 120);
  }
  return "unknown_error";
}

export function isProviderTimeoutError(error: unknown): boolean {
  return safeErrorCode(error) === "provider_timeout";
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
    estimated_cost_usd:
      input.status === "failed"
        ? null
        : estimateAnthropicCostUsd(input.context.model, input.usage),
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
