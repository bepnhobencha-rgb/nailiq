/** Voice AI configuration constants */

// gpt-4o-realtime-preview* removed 2026-05-07; GA line is gpt-realtime-2.x.
// Bumped to 2.1 (smarter comprehension/reasoning) — used by web + phone.
export const VOICE_MODEL = "gpt-realtime-2.1";

/** GA endpoint for minting ephemeral client secrets (ek_...) */
export const OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
export const OPENAI_SDP_URL            = "https://api.openai.com/v1/realtime";

// gpt-realtime-2 uses semantic_vad (replaces server_vad with threshold/padding)
export const DEFAULT_VAD = {
  type:               "semantic_vad",
  eagerness:          "low",
  create_response:    true,
  // true: allows the customer to interrupt Lily mid-sentence.
  // Browser echoCancellation + far_field noise reduction prevent self-interruption.
  interrupt_response: true,
} as const;

export const SUPPORTED_VOICES = [
  "alloy", "ash", "ballad", "cedar", "coral",
  "echo", "fable", "marin", "nova", "onyx",
  "sage", "shimmer", "verse",
] as const;
export type SupportedVoice = (typeof SUPPORTED_VOICES)[number];

export const SUPPORTED_LANGUAGES = ["vi", "en", "es", "fr", "zh"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === "string"
    && SUPPORTED_LANGUAGES.includes(value as SupportedLanguage);
}

export function normalizeSupportedLanguage(
  value: unknown,
  fallback: SupportedLanguage = "en",
): SupportedLanguage {
  return isSupportedLanguage(value) ? value : fallback;
}

/** Maps salon DB values to OpenAI reasoning_effort values */
export const REASONING_EFFORT_MAP: Record<string, "low" | "medium" | "high"> = {
  minimal: "low",
  low:     "low",
  medium:  "medium",
  high:    "high",
  xhigh:   "high",
};

export const SESSION_TTL_SECONDS = 1800; // 30 min — matches the max OpenAI ephemeral-key TTL
