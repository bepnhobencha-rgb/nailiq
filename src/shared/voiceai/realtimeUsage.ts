export const REALTIME_USAGE_SCHEMA_VERSION = 1 as const;

export type RealtimeUsage = {
  schemaVersion: typeof REALTIME_USAGE_SCHEMA_VERSION;
  responseCount: number;
  inputTextTokens: number;
  inputAudioTokens: number;
  inputImageTokens: number;
  cachedInputTextTokens: number;
  cachedInputAudioTokens: number;
  cachedInputImageTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
  transcriptionAudioTokens: number;
};

export const EMPTY_REALTIME_USAGE: Readonly<RealtimeUsage> = Object.freeze({
  schemaVersion: REALTIME_USAGE_SCHEMA_VERSION,
  responseCount: 0,
  inputTextTokens: 0,
  inputAudioTokens: 0,
  inputImageTokens: 0,
  cachedInputTextTokens: 0,
  cachedInputAudioTokens: 0,
  cachedInputImageTokens: 0,
  outputTextTokens: 0,
  outputAudioTokens: 0,
  transcriptionAudioTokens: 0,
});

const TOKEN_KEYS = [
  "responseCount",
  "inputTextTokens",
  "inputAudioTokens",
  "inputImageTokens",
  "cachedInputTextTokens",
  "cachedInputAudioTokens",
  "cachedInputImageTokens",
  "outputTextTokens",
  "outputAudioTokens",
  "transcriptionAudioTokens",
] as const;

const MAX_SESSION_TOKENS = 10_000_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedTokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(MAX_SESSION_TOKENS, Math.max(0, Math.trunc(value)));
}

export function normalizeRealtimeUsage(value: unknown): RealtimeUsage {
  const raw = record(value);
  const normalized = { ...EMPTY_REALTIME_USAGE };
  for (const key of TOKEN_KEYS) normalized[key] = boundedTokenCount(raw[key]);
  return normalized;
}

export function addRealtimeUsage(
  currentValue: unknown,
  additionValue: unknown,
): RealtimeUsage {
  const current = normalizeRealtimeUsage(currentValue);
  const addition = normalizeRealtimeUsage(additionValue);
  const next = { ...EMPTY_REALTIME_USAGE };
  for (const key of TOKEN_KEYS) {
    next[key] = boundedTokenCount(current[key] + addition[key]);
  }
  return next;
}

/**
 * Extract token counters from one OpenAI Realtime event. No transcript, status
 * message, tool argument, or caller content is retained.
 */
export function realtimeUsageFromEvent(eventValue: unknown): RealtimeUsage {
  const event = record(eventValue);
  if (event.type === "response.done") {
    const response = record(event.response);
    const usage = record(response.usage);
    const input = record(usage.input_token_details);
    const cached = record(input.cached_tokens_details);
    const output = record(usage.output_token_details);
    return normalizeRealtimeUsage({
      responseCount: 1,
      inputTextTokens: input.text_tokens,
      inputAudioTokens: input.audio_tokens,
      inputImageTokens: input.image_tokens,
      cachedInputTextTokens: cached.text_tokens,
      cachedInputAudioTokens: cached.audio_tokens,
      cachedInputImageTokens: cached.image_tokens,
      outputTextTokens: output.text_tokens,
      outputAudioTokens: output.audio_tokens,
    });
  }

  if (event.type === "conversation.item.input_audio_transcription.completed") {
    const usage = record(event.usage);
    const input = record(usage.input_token_details);
    return normalizeRealtimeUsage({
      transcriptionAudioTokens: input.audio_tokens,
    });
  }

  return { ...EMPTY_REALTIME_USAGE };
}

type RealtimePricing = {
  asOf: string;
  textInputPerMillion: number;
  textCachedInputPerMillion: number;
  textOutputPerMillion: number;
  audioInputPerMillion: number;
  audioCachedInputPerMillion: number;
  audioOutputPerMillion: number;
  imageInputPerMillion: number;
  imageCachedInputPerMillion: number;
  transcriptionUsdPerMinute: number;
};

// Official OpenAI pricing for the exact model pinned by VOICE_MODEL. Keep this
// model-keyed and dated so a future model change cannot silently reuse an old
// rate card. Transcription uses gpt-realtime-whisper at $0.017/minute.
const PRICING_BY_MODEL: Readonly<Record<string, RealtimePricing>> = Object.freeze({
  "gpt-realtime-2.1": {
    asOf: "2026-08-01",
    textInputPerMillion: 4,
    textCachedInputPerMillion: 0.4,
    textOutputPerMillion: 24,
    audioInputPerMillion: 32,
    audioCachedInputPerMillion: 0.4,
    audioOutputPerMillion: 64,
    imageInputPerMillion: 5,
    imageCachedInputPerMillion: 0.5,
    transcriptionUsdPerMinute: 0.017,
  },
});

export type RealtimeCostEstimate = {
  model: string;
  pricingAsOf: string;
  estimatedCostUsd: number;
  usage: RealtimeUsage;
};

export function estimateRealtimeCostUsd(
  modelValue: unknown,
  usageValue: unknown,
): RealtimeCostEstimate | null {
  if (typeof modelValue !== "string") return null;
  const model = modelValue.trim();
  const pricing = PRICING_BY_MODEL[model];
  if (!pricing) return null;

  const usage = normalizeRealtimeUsage(usageValue);
  const uncachedText = Math.max(0, usage.inputTextTokens - usage.cachedInputTextTokens);
  const uncachedAudio = Math.max(0, usage.inputAudioTokens - usage.cachedInputAudioTokens);
  const uncachedImage = Math.max(0, usage.inputImageTokens - usage.cachedInputImageTokens);
  const perMillion = (
    uncachedText * pricing.textInputPerMillion +
    usage.cachedInputTextTokens * pricing.textCachedInputPerMillion +
    uncachedAudio * pricing.audioInputPerMillion +
    usage.cachedInputAudioTokens * pricing.audioCachedInputPerMillion +
    uncachedImage * pricing.imageInputPerMillion +
    usage.cachedInputImageTokens * pricing.imageCachedInputPerMillion +
    usage.outputTextTokens * pricing.textOutputPerMillion +
    usage.outputAudioTokens * pricing.audioOutputPerMillion
  ) / 1_000_000;
  // Realtime transcription audio tokens represent about 100 ms each.
  const transcription = usage.transcriptionAudioTokens * 0.1 / 60 *
    pricing.transcriptionUsdPerMinute;

  return {
    model,
    pricingAsOf: pricing.asOf,
    estimatedCostUsd: Math.round((perMillion + transcription) * 1_000_000) / 1_000_000,
    usage,
  };
}
