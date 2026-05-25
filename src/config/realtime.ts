/**
 * Single source of truth for OpenAI Realtime Voice config.
 *
 * DO NOT hardcode model/voice elsewhere — import REALTIME_CONFIG from here.
 *
 * GA WebRTC SDP pattern (CONFIRMED WORKING):
 *   POST https://api.openai.com/v1/realtime?model=gpt-realtime-2025-08-28
 *   Authorization: Bearer <key>
 *   Content-Type: application/sdp
 *   Body: raw SDP offer string
 *   NO OpenAI-Beta header — that header triggers beta_api_shape_disabled
 *
 * To override in production set OPENAI_REALTIME_MODEL / OPENAI_REALTIME_VOICE
 * in Vercel env vars.
 */

export const REALTIME_CONFIG = {
  /** GA model — confirmed working. Override via OPENAI_REALTIME_MODEL env var. */
  model: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2025-08-28",
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
