type UsageInsertError = { code?: string } | null;

export type EdgeUsageLedgerClient = {
  from(table: "ai_usage_events"): {
    insert(
      row: Record<string, unknown>,
    ): PromiseLike<{ error: UsageInsertError }>;
  };
};

type NormalizedAnthropicUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

type AnthropicPrice = {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
};

// Keep this pricing snapshot aligned with src/shared/ai/usageLedger.ts.
// Unknown models remain observable but deliberately receive no cost estimate.
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

function normalizeAnthropicUsage(
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

function estimateAnthropicCostUsd(
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

async function writeUsageEvent(
  db: EdgeUsageLedgerClient,
  row: Record<string, unknown>,
): Promise<void> {
  try {
    const { error } = await db.from("ai_usage_events").insert(row);
    if (error) console.warn("[ai-usage-edge] telemetry insert failed", error.code);
  } catch (error) {
    console.warn("[ai-usage-edge] telemetry unavailable", safeErrorCode(error));
  }
}

export async function trackAnthropicEdgeFetch(
  db: EdgeUsageLedgerClient,
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
        usage = normalizeAnthropicUsage(await response.clone().json());
      } catch {
        usage = null;
      }
    }
    const normalized = usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    await writeUsageEvent(db, {
      salon_id: context.salonId,
      provider: "anthropic",
      feature: context.feature,
      model: context.model,
      status: response.ok ? "succeeded" : "failed",
      input_tokens: normalized.inputTokens,
      output_tokens: normalized.outputTokens,
      cache_read_input_tokens: normalized.cacheReadInputTokens,
      cache_creation_input_tokens: normalized.cacheCreationInputTokens,
      estimated_cost_usd: estimateAnthropicCostUsd(context.model, normalized),
      latency_ms: Math.max(0, Date.now() - startedAt),
      error_code: response.ok
        ? usage
          ? null
          : "usage_unavailable"
        : `http_${response.status}`,
    });
    return response;
  } catch (error) {
    await writeUsageEvent(db, {
      salon_id: context.salonId,
      provider: "anthropic",
      feature: context.feature,
      model: context.model,
      status: "failed",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      estimated_cost_usd: 0,
      latency_ms: Math.max(0, Date.now() - startedAt),
      error_code: safeErrorCode(error),
    });
    throw error;
  }
}
