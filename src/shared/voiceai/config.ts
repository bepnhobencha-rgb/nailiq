/** Voice AI configuration constants — gpt-realtime-2 GA */

export const VOICE_MODEL = "gpt-realtime-2";

/** GA endpoint for minting ephemeral client secrets (ek_...) */
export const OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
export const OPENAI_SDP_URL            = "https://api.openai.com/v1/realtime";

export const DEFAULT_VAD = {
  type:                "server_vad",
  threshold:           0.45,
  prefix_padding_ms:   200,
  silence_duration_ms: 700,
} as const;

export const SUPPORTED_VOICES = [
  "alloy", "ash", "ballad", "cedar", "coral",
  "echo", "fable", "marin", "nova", "onyx",
  "sage", "shimmer", "verse",
] as const;
export type SupportedVoice = (typeof SUPPORTED_VOICES)[number];

export const SUPPORTED_LANGUAGES = ["vi", "en", "fr", "zh"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Maps salon DB values to OpenAI reasoning_effort values */
export const REASONING_EFFORT_MAP: Record<string, "low" | "medium" | "high"> = {
  minimal: "low",
  low:     "low",
  medium:  "medium",
  high:    "high",
  xhigh:   "high",
};

export const SESSION_TTL_SECONDS = 90;
