// V2 clean-room constants — no legacy imports
export const REALTIME_MODEL = "gpt-4o-realtime-preview";
export const REALTIME_VOICE = "shimmer";
export const REALTIME_TRANSCRIPTION_MODEL = "whisper-1";
export const REALTIME_VAD = {
  threshold:         0.45,
  prefixPaddingMs:   200,
  silenceDurationMs: 700,
} as const;
