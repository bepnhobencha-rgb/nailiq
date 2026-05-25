/**
 * Single source of truth for OpenAI Realtime Voice config.
 *
 * DO NOT hardcode model/voice/endpoint elsewhere — import from here.
 * To override in production set OPENAI_REALTIME_MODEL / OPENAI_REALTIME_VOICE
 * in Vercel env vars. Defaults below are the last confirmed working GA values.
 */

export const REALTIME_CONFIG = {
  /** GA model confirmed working — do not change without testing first */
  model: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2025-08-28",
  /** GA voice confirmed working */
  voice: process.env.OPENAI_REALTIME_VOICE ?? "marin",
  /** Transcription model for input audio */
  transcriptionModel: "gpt-realtime-whisper",
  /** WebRTC SDP endpoint */
  sdpEndpoint: "https://api.openai.com/v1/realtime/calls",
  /** Transport layer */
  transport: "webrtc",
  /** VAD settings */
  vad: {
    threshold: 0.45,
    prefixPaddingMs: 200,
    silenceDurationMs: 700,
  },
  /** Temperature for AI responses */
  temperature: 0.7,
} as const;

/** Validate at runtime — call once at startup before serving voice routes */
export function validateRealtimeConfig(): void {
  const { model, voice } = REALTIME_CONFIG;

  if (!model || model.trim() === "") {
    throw new Error("[realtime-config] model is empty");
  }
  if (!voice || voice.trim() === "") {
    throw new Error("[realtime-config] voice is empty");
  }

  // Warn about known bad values that have caused regressions
  const KNOWN_BAD_MODELS = [
    "gpt-4o-realtime-preview",
    "gpt-4o-realtime-preview-2024-12-17",
    "gpt-realtime-2",
  ];
  if (KNOWN_BAD_MODELS.includes(model)) {
    console.warn(
      `[realtime-config] WARNING: model="${model}" is a deprecated preview/beta name that caused 404s. ` +
      `Use OPENAI_REALTIME_MODEL env var to override or update the default in src/config/realtime.ts.`,
    );
  }

  console.info(
    `[realtime-config] model=${model} voice=${voice} transport=${REALTIME_CONFIG.transport} ` +
    `endpoint=${REALTIME_CONFIG.sdpEndpoint}`,
  );
}
