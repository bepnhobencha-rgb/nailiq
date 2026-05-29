/** Voice AI configuration constants */

// gpt-4o-realtime-preview* removed 2026-05-07; GA successor is gpt-realtime-2
export const VOICE_MODEL = "gpt-realtime-2";

/** GA endpoint for minting ephemeral client secrets (ek_...) */
export const OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
export const OPENAI_SDP_URL            = "https://api.openai.com/v1/realtime";

// gpt-realtime-2 uses semantic_vad (replaces server_vad with threshold/padding)
export const DEFAULT_VAD = {
  type:               "semantic_vad",
  eagerness:          "low",
  create_response:    true,
  // false: prevents self-interruption when speaker echo triggers VAD.
  interrupt_response: false,
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

export const SESSION_TTL_SECONDS = 300;
