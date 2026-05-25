/**
 * Single source of truth for OpenAI Realtime Voice config.
 *
 * GA WebRTC SDP pattern:
 *   POST https://api.openai.com/v1/realtime?model=<model>
 *   Authorization: Bearer <key>
 *   Content-Type: application/sdp
 *   Body: raw SDP offer string
 *
 * Valid GA models (as of 2025):
 *   gpt-4o-realtime-preview-2024-12-17   ← pinned stable version
 *   gpt-4o-realtime-preview              ← latest alias
 *   gpt-4o-mini-realtime-preview-2024-12-17
 *
 * DO NOT add OpenAI-Beta: realtime=v1 header — that is the OLD beta API.
 * DO NOT use /v1/realtime/calls or FormData — those endpoints do not exist.
 * DO NOT use model names that are not in the list above.
 */

export const REALTIME_CONFIG = {
  /** GA model — pinned to stable dated version */
  model: process.env.OPENAI_REALTIME_MODEL ?? "gpt-4o-realtime-preview-2024-12-17",
  /** GA voice — must be one of: alloy, ash, ballad, coral, echo, sage, shimmer, verse */
  voice: process.env.OPENAI_REALTIME_VOICE ?? "shimmer",
  /** Transcription model for input audio — whisper-1 is the only valid value */
  transcriptionModel: "whisper-1",
  /** WebRTC SDP base endpoint — model is appended as ?model= query param */
  sdpEndpoint: "https://api.openai.com/v1/realtime",
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
  /**
   * Safe mode: disable all tools so the session reduces to connect+listen+speak only.
   * Set NEXT_PUBLIC_VOICE_SAFE_MODE=1 to activate.
   */
  safeMode: process.env.NEXT_PUBLIC_VOICE_SAFE_MODE === "1",
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

  console.info(
    `[realtime-config] model=${model} voice=${voice} transport=${REALTIME_CONFIG.transport} ` +
    `endpoint=${REALTIME_CONFIG.sdpEndpoint}`,
  );
}
