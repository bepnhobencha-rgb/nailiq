export const VOICE_SESSION_CHANNELS = [
  "web_direct",
  "web_embed",
  "phone_twilio",
] as const;

export type VoiceSessionChannel = (typeof VOICE_SESSION_CHANNELS)[number];

export const VOICE_FAILURE_CODES = [
  "insecure_context",
  "mic_permission_denied",
  "mic_not_found",
  "mic_capture_failed",
  "audio_pipeline_failed",
  "session_init_failed",
  "ws_connect_failed",
  "ws_closed_clean",
  "ws_closed_unexpected",
  "realtime_error",
] as const;

export type VoiceFailureCode = (typeof VOICE_FAILURE_CODES)[number];

export type VoiceClientDiagnostics = {
  schemaVersion: 1;
  channel: Extract<VoiceSessionChannel, "web_direct" | "web_embed">;
  requested: {
    echoCancellation: true;
    noiseSuppression: true;
    autoGainControl: true;
    sampleRate: 24000;
  };
  applied: {
    echoCancellation: boolean | null;
    noiseSuppression: boolean | null;
    autoGainControl: boolean | null;
    sampleRate: number | null;
  } | null;
  outputMode: "media_element" | "audio_context_fallback";
};

const WEB_CHANNELS = new Set<VoiceSessionChannel>(["web_direct", "web_embed"]);
const FAILURE_CODES = new Set<VoiceFailureCode>(VOICE_FAILURE_CODES);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function nullableSampleRate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded >= 8_000 && rounded <= 96_000 ? rounded : null;
}

export function normalizeVoiceSessionChannel(value: unknown): VoiceSessionChannel {
  return typeof value === "string" && WEB_CHANNELS.has(value as VoiceSessionChannel)
    ? value as VoiceSessionChannel
    : "web_direct";
}

export function voiceSessionChannelFromPathname(pathname: string): VoiceClientDiagnostics["channel"] {
  return pathname.startsWith("/embed/") ? "web_embed" : "web_direct";
}

export function normalizeVoiceFailureCode(value: unknown): VoiceFailureCode | null {
  return typeof value === "string" && FAILURE_CODES.has(value as VoiceFailureCode)
    ? value as VoiceFailureCode
    : null;
}

export function classifyVoiceFailure(
  name: string,
  message: string,
  stage?: "session_init" | "mic_request" | "connecting",
): VoiceFailureCode {
  if (stage === "session_init") return "session_init_failed";
  if (name === "NotAllowedError") return "mic_permission_denied";
  if (name === "NotFoundError") return "mic_not_found";
  if (message === "insecure_context") return "insecure_context";
  if (stage === "connecting") return "audio_pipeline_failed";
  if (message.startsWith("session_init_") || [
    "voice_not_enabled",
    "session_limit_reached",
    "openai_rate_limit",
  ].includes(message)) return "session_init_failed";
  return "mic_capture_failed";
}

export function normalizeVoiceClientDiagnostics(value: unknown): VoiceClientDiagnostics | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = record(value);
  const applied = record(raw.applied);
  const channel = normalizeVoiceSessionChannel(raw.channel);
  if (channel === "phone_twilio") return null;

  return {
    schemaVersion: 1,
    channel,
    requested: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 24000,
    },
    applied: raw.applied === null || raw.applied === undefined
      ? null
      : {
          echoCancellation: nullableBoolean(applied.echoCancellation),
          noiseSuppression: nullableBoolean(applied.noiseSuppression),
          autoGainControl: nullableBoolean(applied.autoGainControl),
          sampleRate: nullableSampleRate(applied.sampleRate),
        },
    outputMode: raw.outputMode === "audio_context_fallback"
      ? "audio_context_fallback"
      : "media_element",
  };
}
