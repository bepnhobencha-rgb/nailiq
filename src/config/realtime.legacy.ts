export const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2025-08-28";
export const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE ?? "shimmer";
export const REALTIME_TRANSCRIPTION_MODEL = "whisper-1";

export const REALTIME_VAD = {
  threshold:        0.45,
  prefixPaddingMs:  200,
  silenceDurationMs: 700,
} as const;
