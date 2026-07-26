/**
 * Pure message translation between Twilio Media Streams and the OpenAI Realtime
 * API. No I/O here — server.ts owns the two WebSockets and calls these to build
 * the messages to send. Keeping the protocol mapping pure makes it unit-testable
 * without a live call (which we cannot place from CI).
 *
 * Audio: Twilio Media Streams and OpenAI Realtime both speak G.711 μ-law at
 * 8 kHz (`g711_ulaw`), so no transcoding is needed — payloads pass through as
 * base64. This is the whole reason the bridge is thin.
 *
 * NOTE (live bring-up): OpenAI has revised Realtime event names across versions
 * (e.g. `response.audio.delta` vs `response.output_audio.delta`). We accept the
 * known variants below; verify against the current Realtime docs when wiring the
 * real key, since this file cannot be exercised end-to-end without a phone call.
 */

// Discriminated union of the Twilio Media Stream events we act on. Unknown
// events (e.g. "connected") simply match no branch in the handler; "mark" is
// consumed by the playback-aware hangup (see extractMarkName / server.ts).
export type TwilioInbound =
  | { event: "connected" }
  | { event: "start"; start: { streamSid: string; callSid?: string; customParameters?: Record<string, string> } }
  | { event: "media"; media: { payload: string } }
  | { event: "mark"; mark?: { name: string } }
  | { event: "stop" };

export type RealtimeSessionConfig = {
  instructions: string;
  voice: string;
  tools: unknown[];
  /** BCP-47 hint for the transcriber. On 8 kHz phone audio, hinting the right
   *  language raises accuracy sharply — an un-hinted Vietnamese call transcribed
   *  as Arabic in testing. Omit to let Whisper auto-detect. */
  transcribeLang?: string | null;
  /** When false, the model's current response is NOT cancelled if the caller
   *  (or line echo) starts talking. Set false only while a protected line — the
   *  booking confirmation / OTP notice — is being spoken, then restored to true.
   *  Defaults to true (normal turns stay interruptible). */
  interruptResponse?: boolean;
};

/** Bound each turn so a short phone reply cannot reserve the model's entire
 * output allowance. Audio tokens are included, so this still leaves ample room
 * for a concise confirmation while reducing token-rate pressure. */
export const REALTIME_MAX_OUTPUT_TOKENS = 512;

/** Slightly calmer than the model default. The opening prompt adds an explicit
 * pause around the salon name, while this keeps the rest of the call natural. */
export const REALTIME_SPEECH_SPEED = 0.92;

/** Keep enough recent dialogue to finish a booking while dropping old turns in
 * batches. Retaining 80% avoids a cache-busting truncation on every later turn. */
export const REALTIME_POST_INSTRUCTION_TOKEN_LIMIT = 8_000;
export const REALTIME_TRUNCATION_RETENTION_RATIO = 0.8;

/** A voice-tool HTTP call must never leave the caller in dead air indefinitely. */
export const TOOL_REQUEST_TIMEOUT_MS = 12_000;

/** Only side-effect-free reads may be retried after a transport/5xx failure.
 *  A timed-out write may already have committed, so retrying it could duplicate
 *  a booking, cancellation, waitlist entry, OTP, or owner message. */
const READ_ONLY_VOICE_TOOLS = new Set([
  "get_available_slots",
  "get_group_available_slots",
  "find_booking",
  "lookup_customer",
]);

export function voiceToolMaxAttempts(name: string): 1 | 2 {
  return READ_ONLY_VOICE_TOOLS.has(name) ? 2 : 1;
}

/** Transport-only no-op used when Realtime detects silence, TV, or side speech.
 *  It is deliberately answered without creating another model response. */
export function isSilentTransportTool(name: string): boolean {
  return name === "wait_for_user";
}

/** Never put a carrier-verified caller number in infrastructure logs. */
export function callerPresenceLabel(phone: string): "present" | "missing" {
  return phone ? "present" : "missing";
}

/**
 * server_vad turn detection, tuned for 8 kHz phone audio. Defaults
 * (threshold 0.5, silence 500ms) false-triggered on line echo and the caller's
 * own short "Hello", cancelling the AI mid-word ("...Shall"). Raising the
 * threshold and lengthening the silence window makes brief noise stop cutting
 * responses. `interrupt_response` is what actually cancels; it is togglable so a
 * protected line can play uninterrupted.
 */
export function turnDetection(interruptResponse: boolean): object {
  return {
    type: "server_vad",
    threshold: 0.6,
    prefix_padding_ms: 300,
    silence_duration_ms: 700,
    // The coordinator is the SOLE creator of responses (see
    // createResponseCoordinator). Auto-creation would race the coordinator's own
    // response.create calls — two responses at once → "already active" errors and
    // a response.done ending the wrong response's protection.
    create_response: false,
    interrupt_response: interruptResponse,
  };
}

/** The `audio.input` block — shared by the initial session.update and the
 *  mid-call interrupt toggle so the two never drift. */
export function audioInput(interruptResponse: boolean, transcribeLang?: string | null): object {
  return {
    format: { type: "audio/pcmu" },
    turn_detection: turnDetection(interruptResponse),
    transcription: {
      model: "gpt-realtime-whisper",
      ...(transcribeLang ? { language: transcribeLang } : {}),
    },
  };
}

/** Minimal session.update that toggles ONLY barge-in (and keeps the transcribe
 *  language stable). Used to protect / un-protect a spoken line. */
export function interruptToggleMessage(interruptResponse: boolean, transcribeLang?: string | null): object {
  return {
    type: "session.update",
    session: { type: "realtime", audio: { input: audioInput(interruptResponse, transcribeLang) } },
  };
}

/**
 * Detect the caller's language from a transcript turn, among the languages the
 * agent supports on the phone. Conservative on purpose: return null (no switch)
 * unless the signal is strong, because a wrong switch mid-call is worse than
 * staying put. Strong signals:
 *   • Vietnamese: tone-marked vowels / đ — these never appear in en/es text.
 *   • Spanish: ñ / ¿ / ¡, or common Spanish words (short Spanish often has no
 *     special character, so a small function-word list backs up the accents).
 *   • English: common English function words.
 */
export type SupportedLang = "vi" | "en" | "es" | "fr" | "zh";

export const LANG_NAMES: Record<string, string> = {
  vi: "Vietnamese", en: "English", es: "Spanish", fr: "French", zh: "Chinese",
};

export function detectLanguage(text: string): "vi" | "es" | "en" | null {
  const t = text.toLowerCase().trim();
  if (!t) return null;
  if (/[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i.test(text)) return "vi";
  if (/[ñ¿¡]/.test(text)) return "es";
  if (/\b(hola|gracias|quiero|cita|uñas|una|por favor|buenos|buenas|sí|para|con|cómo|qué|dónde|cuándo|mañana|hoy|reservar|pedicura|manicura|señor|señora)\b/.test(t)) return "es";
  if (/\b(the|want|book|today|tomorrow|yes|no|please|appointment|nails|hello|thanks|with|for|would|like)\b/.test(t)) return "en";
  return null;
}

/**
 * Detect an EXPLICIT request to switch language, e.g. "Can we continue in
 * Spanish?" — which is English text, so detectLanguage would never catch it.
 * Returns the REQUESTED language, or null. Distinct from detectLanguage (which
 * reads the language actually being spoken); this must run first.
 */
export function detectLanguageRequest(text: string): SupportedLang | null {
  const t = text.toLowerCase();
  const asksFor = (names: string) => new RegExp(
    `\\b(?:speak|continue(?:\\s+in)?|use|switch(?:\\s+to)?)\\s+(?:${names})\\b`,
  ).test(t);
  // Native + Vietnamese names for each language — a Vietnamese caller asks for
  // Chinese as "tiếng Hoa" / "tiếng Trung", not "Chinese".
  if (/中文|tiếng hoa|tieng hoa|tiếng trung|tieng trung|tiếng quảng|tiếng phổ thông|tiếng tàu/.test(t)
      || /\b(?:in|to) (?:chinese|mandarin)\b/.test(t) || asksFor("chinese|mandarin")) return "zh";
  if (/tiếng việt|tieng viet/.test(t) || /\b(?:in|to) vietnamese\b/.test(t) || asksFor("vietnamese")) return "vi";
  if (/tiếng tây ban nha|tieng tay ban nha|\b(?:in|to) spanish\b|en español|en espanol|español|espanol/.test(t) || asksFor("spanish")) return "es";
  if (/tiếng pháp|tieng phap|\b(?:in|to) french\b|en français|en francais|français|francais/.test(t) || asksFor("french")) return "fr";
  if (/tiếng anh|\b(?:in|to) english\b|english please|en inglés|en ingles/.test(t) || asksFor("english")) return "en";
  return null;
}

/**
 * Decide which language to switch to for a caller turn, or null to stay put.
 * An explicit request (detectLanguageRequest) wins over the spoken-language
 * heuristic — a caller can ASK in English to be served in Spanish.
 */
export function resolveSwitchLanguage(text: string, current: string): SupportedLang | null {
  const requested = detectLanguageRequest(text);
  if (requested) return requested !== current ? requested : null;
  const spoken = detectLanguage(text);
  if (spoken && spoken !== current) return spoken;
  return null;
}

/**
 * OpenAI `session.update` (GA Realtime API shape). The Beta shape
 * (top-level input_audio_format / modalities / voice) was retired — GA nests
 * audio config under `audio.input` / `audio.output`, μ-law is `audio/pcmu`, and
 * the voice moves under `audio.output.voice`. Event names for deltas are handled
 * tolerantly in extractAudioDelta.
 */
export function sessionUpdateMessage(cfg: RealtimeSessionConfig): object {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: cfg.instructions,
      tools: cfg.tools,
      max_output_tokens: REALTIME_MAX_OUTPUT_TOKENS,
      truncation: {
        type: "retention_ratio",
        retention_ratio: REALTIME_TRUNCATION_RETENTION_RATIO,
        token_limits: { post_instructions: REALTIME_POST_INSTRUCTION_TOKEN_LIMIT },
      },
      audio: {
        input: audioInput(cfg.interruptResponse ?? true, cfg.transcribeLang),
        output: {
          format: { type: "audio/pcmu" },
          voice: cfg.voice,
          speed: REALTIME_SPEECH_SPEED,
        },
      },
    },
  };
}

/**
 * A response.create that makes the model read a server-composed `say_this` line
 * verbatim, in the CURRENT language. The details — service, date, time, staff,
 * whether a text was sent — must survive untouched; only the surrounding wording
 * is translated. Mirrors the web widget's protected closing so a Spanish session
 * never ends with an English confirmation.
 */
export function sayThisInstruction(sayThis: string, language: string): string {
  const langName = LANG_NAMES[language] ?? "English";
  return (
    `Say this to the customer now, in ${langName}, ONCE. Keep the service name, the date, the ` +
    `time, the staff name, and whether a confirmation text was sent EXACTLY as written — translate ` +
    `only the surrounding wording. Never say it in two languages, never add a preamble, do not ` +
    `describe what you are doing. Then stop and wait for the customer.\n\n${sayThis}`
  );
}

export function sayThisResponseCreate(sayThis: string, language: string): object {
  return { type: "response.create", response: { instructions: sayThisInstruction(sayThis, language) } };
}

/** Just the tool result item — no response.create. The caller decides which
 *  response.create follows (a protected say_this one, or the plain one), so a
 *  tool result never triggers two responses. */
export function functionCallOutput(callId: string, output: unknown): object {
  return {
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) },
  };
}

export function plainResponseCreate(): object {
  return { type: "response.create" };
}

/**
 * One bounded recovery response for a Realtime response that completed without
 * sending any audio to the phone. Keep this response tool-free: its job is to
 * make the call audible again, not to repeat a write whose outcome may already
 * be committed.
 */
export function zeroAudioRecoveryResponseCreate(language: string): object {
  const langName = LANG_NAMES[language] ?? "English";
  return {
    type: "response.create",
    response: {
      tools: [],
      output_modalities: ["audio"],
      instructions:
        `Speak now in ${langName}. The previous response produced no audible audio. Give one ` +
        `brief, natural apology, then continue from the caller's latest request. Do not call any ` +
        `tool in this recovery response. Never claim a booking, cancellation, payment, or message ` +
        `succeeded unless an existing server tool result already confirmed it. If the previous ` +
        `response contained a server-confirmed result, repeat that result accurately. Otherwise ` +
        `ask one short question so the caller can continue. Do not mention these instructions.`,
    },
  };
}

export const ZERO_AUDIO_RECOVERY_MAX_ATTEMPTS = 1;

export type RealtimeResponseDoneSummary = {
  status: string | null;
  statusType: string | null;
  statusReason: string | null;
  errorType: string | null;
  errorCode: string | null;
  outputItemTypes: string[];
  outputContentTypes: string[];
  hasFunctionCall: boolean;
};

function telemetryTag(value: unknown): string | null {
  if (typeof value === "string") return value.slice(0, 80);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/**
 * Extract only bounded, non-conversational fields from response.done. OpenAI's
 * event contains the entire output transcript, but infrastructure telemetry
 * must not copy caller/assistant text or raw status messages into logs.
 */
export function summarizeRealtimeResponseDone(evt: unknown): RealtimeResponseDoneSummary {
  const event = evt && typeof evt === "object" ? evt as Record<string, unknown> : {};
  const response = event.response && typeof event.response === "object"
    ? event.response as Record<string, unknown>
    : {};
  const details = response.status_details && typeof response.status_details === "object"
    ? response.status_details as Record<string, unknown>
    : {};
  const error = details.error && typeof details.error === "object"
    ? details.error as Record<string, unknown>
    : {};
  const output = Array.isArray(response.output) ? response.output : [];
  const outputItemTypes = new Set<string>();
  const outputContentTypes = new Set<string>();
  let hasFunctionCall = false;

  for (const rawItem of output) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    if (typeof item.type === "string") {
      outputItemTypes.add(item.type);
      if (item.type === "function_call") hasFunctionCall = true;
    }
    if (!Array.isArray(item.content)) continue;
    for (const rawContent of item.content) {
      if (!rawContent || typeof rawContent !== "object") continue;
      const contentType = (rawContent as Record<string, unknown>).type;
      if (typeof contentType === "string") outputContentTypes.add(contentType);
    }
  }

  return {
    status: telemetryTag(response.status),
    statusType: telemetryTag(details.type),
    statusReason: telemetryTag(details.reason),
    errorType: telemetryTag(error.type),
    errorCode: telemetryTag(error.code),
    outputItemTypes: [...outputItemTypes],
    outputContentTypes: [...outputContentTypes],
    hasFunctionCall,
  };
}

export type RealtimeRateLimitSummary = {
  name: string;
  limit: number | null;
  remaining: number | null;
  resetSeconds: number | null;
};

function finiteNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Extract only safe numeric quota telemetry. Never log the full event: future
 * API revisions may add fields that are not intended for infrastructure logs.
 */
export function summarizeRealtimeRateLimitsUpdated(evt: unknown): RealtimeRateLimitSummary[] {
  const event = evt && typeof evt === "object" ? evt as Record<string, unknown> : {};
  const limits = Array.isArray(event.rate_limits) ? event.rate_limits : [];
  const summaries: RealtimeRateLimitSummary[] = [];

  for (const rawLimit of limits.slice(0, 10)) {
    if (!rawLimit || typeof rawLimit !== "object") continue;
    const limit = rawLimit as Record<string, unknown>;
    const name = telemetryTag(limit.name);
    if (!name) continue;
    summaries.push({
      name,
      limit: finiteNonNegativeNumber(limit.limit),
      remaining: finiteNonNegativeNumber(limit.remaining),
      resetSeconds: finiteNonNegativeNumber(limit.reset_seconds),
    });
  }
  return summaries;
}

export function isTokenRateLimitExceeded(summary: RealtimeResponseDoneSummary): boolean {
  return summary.errorType === "tokens" && summary.errorCode === "rate_limit_exceeded";
}

export const TOKEN_RATE_LIMIT_RECOVERY_MAX_ATTEMPTS = 2;
export const TOKEN_RATE_LIMIT_FALLBACK_DELAY_MS = 30_000;
export const TOKEN_RATE_LIMIT_RESET_BUFFER_MS = 500;
export const TOKEN_RATE_LIMIT_MAX_DELAY_MS = 120_000;

export type TokenRateLimitRecoveryDecision =
  | { kind: "none" }
  | { kind: "retry"; delayMs: number; attempt: number }
  | { kind: "exhausted"; attempts: number };

/**
 * Respect the server's token reset window instead of immediately retrying into
 * the same quota failure. At most two consecutive recovery attempts are made;
 * any audible output resets the circuit.
 */
export function createTokenRateLimitRecoveryGuard(
  maxAttempts = TOKEN_RATE_LIMIT_RECOVERY_MAX_ATTEMPTS,
  fallbackDelayMs = TOKEN_RATE_LIMIT_FALLBACK_DELAY_MS,
) {
  let attempts = 0;
  let tokenResetAt = 0;

  return {
    onRateLimits(limits: RealtimeRateLimitSummary[], now = Date.now()) {
      const tokenResetSeconds = limits
        .filter((limit) => limit.name === "tokens" && limit.resetSeconds !== null)
        .map((limit) => limit.resetSeconds as number);
      if (tokenResetSeconds.length > 0) {
        tokenResetAt = now + Math.max(...tokenResetSeconds) * 1_000;
      }
    },
    decide(summary: RealtimeResponseDoneSummary, now = Date.now()): TokenRateLimitRecoveryDecision {
      if (!isTokenRateLimitExceeded(summary)) return { kind: "none" };
      if (attempts >= maxAttempts) return { kind: "exhausted", attempts };
      attempts++;
      const documentedResetDelay = tokenResetAt > now
        ? tokenResetAt - now + TOKEN_RATE_LIMIT_RESET_BUFFER_MS
        : fallbackDelayMs;
      const delayMs = Math.min(
        TOKEN_RATE_LIMIT_MAX_DELAY_MS,
        Math.max(TOKEN_RATE_LIMIT_RESET_BUFFER_MS, Math.ceil(documentedResetDelay)),
      );
      return { kind: "retry", delayMs, attempt: attempts };
    },
    onAudibleOutput() {
      attempts = 0;
      tokenResetAt = 0;
    },
    attempts(): number { return attempts; },
  };
}

/** Encode signed PCM16 into G.711 μ-law, the format Twilio already consumes. */
function linearPcmToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32_635;
  const sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  sample = Math.min(CLIP, sample) + BIAS;

  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (sample & mask) === 0; exponent--, mask >>= 1) {
    // Find the highest populated magnitude bit.
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

/**
 * A quiet 240 ms comfort tone generated locally, independent of OpenAI quota.
 * It tells the caller the line is alive while the bridge waits for the exact
 * token reset window. Each payload is one 20 ms Twilio μ-law frame.
 */
export function tokenRateLimitComfortTonePayloads(): string[] {
  const sampleRate = 8_000;
  const frameSamples = 160;
  const totalFrames = 12;
  const totalSamples = frameSamples * totalFrames;
  const bytes = Buffer.alloc(totalSamples);

  for (let i = 0; i < totalSamples; i++) {
    const edge = Math.min(i / 240, (totalSamples - 1 - i) / 240, 1);
    const envelope = Math.max(0, edge);
    const sample = Math.round(Math.sin(2 * Math.PI * 523.25 * i / sampleRate) * 1_200 * envelope);
    bytes[i] = linearPcmToMulaw(sample);
  }

  const payloads: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += frameSamples) {
    payloads.push(bytes.subarray(offset, offset + frameSamples).toString("base64"));
  }
  return payloads;
}

/**
 * A tool-only response is intentionally silent and a cancelled response is a
 * normal barge-in outcome. Recover only terminal speech responses for which the
 * bridge observed zero audio deltas.
 */
export function shouldRecoverZeroAudio(
  summary: RealtimeResponseDoneSummary,
  audioDeltaCount: number,
): boolean {
  if (audioDeltaCount > 0 || summary.hasFunctionCall) return false;
  // A token quota failure cannot recover immediately. The dedicated guard waits
  // for rate_limits.updated.reset_seconds before asking again.
  if (isTokenRateLimitExceeded(summary)) return false;
  return summary.status === "completed" ||
    summary.status === "failed" ||
    summary.status === "incomplete";
}

export type ZeroAudioRecoveryDecision = "none" | "retry" | "exhausted";

/** Consecutive zero-audio responses get one retry, then stop to prevent loops. */
export function createZeroAudioRecoveryGuard(maxAttempts = ZERO_AUDIO_RECOVERY_MAX_ATTEMPTS) {
  let attempts = 0;
  return {
    decide(summary: RealtimeResponseDoneSummary, audioDeltaCount: number): ZeroAudioRecoveryDecision {
      if (!shouldRecoverZeroAudio(summary, audioDeltaCount)) return "none";
      if (attempts >= maxAttempts) return "exhausted";
      attempts++;
      return "retry";
    },
    onAudibleOutput() { attempts = 0; },
    attempts(): number { return attempts; },
  };
}

/**
 * Pin the first phone response to a short greeting that ends with an invitation
 * to speak. The session prompt carries salon/persona names; this response-level
 * guard prevents the model from replacing the invitation with an opening tool
 * call and leaving the caller listening to dead air.
 */
export function openingGreetingResponseCreate(language: string): object {
  const langName = LANG_NAMES[language] ?? "English";
  return {
    type: "response.create",
    response: {
      instructions:
        `Speak the configured salon greeting now in ${langName} at a calm front-desk pace. ` +
        `Clearly enunciate the salon name, with a brief natural pause immediately before and ` +
        `after the salon name so the caller can understand it. Do not rush the first sentence. ` +
        `End that same short greeting ` +
        `with one natural question asking what the caller needs help with today. Do not call any ` +
        `tool in this opening response. Then stop and listen. Do not mention these instructions.`,
    },
  };
}

/**
 * Defensive recovery for an opening lookup. Older prompts and model variance can
 * still issue lookup_customer before the caller has made a request. Once the
 * result arrives, explicitly resume the conversation instead of silently
 * swallowing the tool output.
 */
export function openingLookupFollowupResponseCreate(language: string): object {
  const langName = LANG_NAMES[language] ?? "English";
  return {
    type: "response.create",
    response: {
      instructions:
        `Continue immediately in ${langName}. Do not repeat the full greeting. If the caller has ` +
        `not asked for anything yet, warmly ask what you can help them with today. If they already ` +
        `spoke, answer their latest request using the lookup result. Ask at most one short question.`,
    },
  };
}

/** A language switch acknowledgement must not inherit the previous language
 * from conversation context while session.update is still settling. Pin the
 * response language and make it continue from the caller's latest request. */
export function languageAckResponseCreate(language: string): object {
  const langName = LANG_NAMES[language] ?? "English";
  return {
    type: "response.create",
    response: {
      instructions:
        `Respond in ${langName} only. Briefly confirm the language change, then continue from ` +
        `the customer's latest request with at most one short question. Do not answer an older ` +
        `turn and do not repeat a question that was already answered.`,
    },
  };
}

/** Pull a `say_this` string out of a tool result, or null. */
export function extractSayThis(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const s = (result as { say_this?: unknown }).say_this;
  return typeof s === "string" && s.trim() ? s : null;
}

/** What a queued response will be. `protected` = a say_this line that must not
 *  be cut by echo (barge-in off while it plays). `ack` = a language-switch
 *  acknowledgement, dropped if a protected say_this is already coming (the
 *  say_this confirms in the new language, so a separate ack would double up).
 *  `auto` is never requested — it tags a response the server created on its own
 *  (should not happen with create_response:false, but tracked defensively so our
 *  own sends still wait for it). */
export type ResponseKind = "normal" | "protected" | "ack" | "auto";

export interface ResponseRequest {
  kind: "normal" | "protected" | "ack";
  /** Built lazily at DISPATCH time, so a say_this queued behind another response
   *  is composed with whatever language is current when it actually plays — a
   *  switch that lands while it waits still makes it come out in the new tongue. */
  build: () => object;
  /** Current language, read lazily, for the interrupt toggles around a protected line. */
  language: () => string;
}

/**
 * The single response coordinator for one call. OpenAI Realtime allows only ONE
 * active response at a time; with server_vad create_response:false this is the
 * SOLE place a response.create is emitted, so nothing races it.
 *
 *   • request() queues; only one response is dispatched at a time; a protected
 *     say_this jumps the queue.
 *   • Responses are tracked by the server's response.id. Only the matching id's
 *     end (done / cancelled / error) may finish that response — a language ack's
 *     response.done can never restore a protected say_this's barge-in.
 *   • interrupt_response is turned OFF right before a protected line and restored
 *     ONLY when that exact protected response ends — at most once.
 *   • Twilio audio is cleared on caller speech only while an UNPROTECTED response
 *     is actually playing (activeId set) — never in dead air, never over say_this.
 */
export function createResponseCoordinator(send: (msg: object) => void) {
  let closed = false;
  let paused = false;
  let activeId: string | null = null;                 // server response.id currently playing
  let activeKind: ResponseKind | null = null;
  let activeLang = "en";
  let awaiting: ResponseRequest | null = null;        // dispatched, awaiting its response.created
  const queue: ResponseRequest[] = [];

  const hasProtected = () =>
    activeKind === "protected" ||
    awaiting?.kind === "protected" ||
    queue.some((r) => r.kind === "protected");

  function dispatch(req: ResponseRequest) {
    awaiting = req;
    if (req.kind === "protected") send(interruptToggleMessage(false, req.language()));
    send(req.build());
  }

  function pump() {
    if (closed || paused || activeId !== null || awaiting !== null) return; // one at a time
    const i = queue.findIndex((r) => r.kind === "protected");     // protected first
    const next = i >= 0 ? queue.splice(i, 1)[0] : queue.shift();
    if (next) dispatch(next);
  }

  return {
    request(req: ResponseRequest) {
      if (closed) return;
      // A language ack is redundant when a protected say_this is already
      // pending/active — that line confirms in the new language on its own.
      if (req.kind === "ack" && hasProtected()) return;
      // Conversational replies are snapshots of the latest caller turn. If a
      // newer turn or language switch arrives while an older reply is queued,
      // the old reply is stale and must never play later. This was the source of
      // callers hearing Chinese after asking for Vietnamese, and of repeated
      // questions after they had already answered.
      if (req.kind === "normal" || req.kind === "ack") {
        for (let i = queue.length - 1; i >= 0; i--) {
          if (queue[i]!.kind === "normal" || queue[i]!.kind === "ack") queue.splice(i, 1);
        }
      }
      // A protected say_this supersedes every pending conversational reply.
      if (req.kind === "protected") {
        for (let i = queue.length - 1; i >= 0; i--) {
          if (queue[i]!.kind === "normal" || queue[i]!.kind === "ack") queue.splice(i, 1);
        }
      }
      queue.push(req);
      pump();
    },
    onResponseCreated(id: string) {
      if (awaiting) {
        activeId = id; activeKind = awaiting.kind; activeLang = awaiting.language();
        awaiting = null;
      } else {
        activeId = id; activeKind = "auto"; // not ours — still block our sends until it ends
      }
    },
    /** Call on response.done / response.cancelled with the event's response.id. */
    onResponseEnded(id: string): boolean {
      if (activeId === null || id !== activeId) return false; // wrong id → never end another response
      const wasProtected = activeKind === "protected";
      const lang = activeLang;
      activeId = null; activeKind = null;
      if (wasProtected) send(interruptToggleMessage(true, lang)); // restore only for the matching protected line
      pump();
      return true;
    },
    /** An error killed the in-flight response. Clear it (restore protection if it
     *  was protected) and keep serving the queue so the call is never stuck. */
    onError() {
      const wasProtected = activeKind === "protected" || awaiting?.kind === "protected";
      const lang = awaiting?.language() ?? activeLang;
      activeId = null; activeKind = null; awaiting = null;
      if (wasProtected) send(interruptToggleMessage(true, lang));
      pump();
    },
    /** Hold queued responses while an external condition (currently a token
     *  reset window) makes dispatch guaranteed to fail. Active lifecycle events
     *  are still processed; resume() pumps the newest safe request afterward. */
    pause() { paused = true; },
    resume() { paused = false; pump(); },
    onClose() { closed = true; queue.length = 0; awaiting = null; activeId = null; activeKind = null; },
    /** Safety net for the server-side watchdog: if a response.done was missed
     *  (e.g. its id could not be matched), activeId/awaiting stays set and pump()
     *  can never dispatch again — the agent goes silent for the rest of the call.
     *  Force the slot clear (restoring barge-in if a protected line was stuck) and
     *  serve the queue. Only the watchdog calls this, and only when genuinely
     *  stalled (busy but no audio for seconds), so it cannot cut a live response. */
    forceRecover(): { recovered: boolean } {
      if (activeId === null && awaiting === null) return { recovered: false };
      const wasProtected = activeKind === "protected" || awaiting?.kind === "protected";
      const lang = awaiting?.language() ?? activeLang;
      activeId = null; activeKind = null; awaiting = null;
      if (wasProtected) send(interruptToggleMessage(true, lang));
      pump();
      return { recovered: true };
    },
    shouldClearOnSpeech(): boolean { return activeId !== null && activeKind !== "protected"; },
    isProtectedActive(): boolean { return activeKind === "protected"; },
    isBusy(): boolean { return activeId !== null || awaiting !== null; },
  };
}

/** Twilio inbound audio → OpenAI input buffer append. */
export function appendAudioMessage(twilioPayloadBase64: string): object {
  return { type: "input_audio_buffer.append", audio: twilioPayloadBase64 };
}

/** OpenAI audio delta → Twilio outbound media frame. */
export function twilioMediaFrame(streamSid: string, audioBase64: string): object {
  return { event: "media", streamSid, media: { payload: audioBase64 } };
}

/** Twilio "clear" — flush queued playback on barge-in (user started speaking). */
export function twilioClearFrame(streamSid: string): object {
  return { event: "clear", streamSid };
}

/**
 * Twilio "mark" — a named checkpoint queued BEHIND all media frames already
 * sent on the stream. Twilio echoes the same mark back only after every frame
 * queued before it has actually been PLAYED to the caller, so it is the one
 * reliable "the caller has heard everything up to here" signal. Used for the
 * playback-aware hangup: send the farewell audio, send a mark, wait for the
 * echo, THEN drop the line — never a fixed timer.
 * https://www.twilio.com/docs/voice/media-streams/websocket-messages
 */
export function twilioMarkFrame(streamSid: string, name: string): object {
  return { event: "mark", streamSid, mark: { name } };
}

/** The name of an inbound Twilio mark acknowledgement, or null if the message
 *  is not a mark event (or carries no name). */
export function extractMarkName(msg: TwilioInbound): string | null {
  return msg.event === "mark" && typeof msg.mark?.name === "string" ? msg.mark.name : null;
}

export const HANGUP_MARK = "hangup-after-farewell";
export const HANGUP_FALLBACK_MS = 5000;

/**
 * Playback-aware hangup, as a pure state machine with injected I/O (same
 * pattern as createResponseCoordinator, and for the same reason: the whole
 * lifecycle is unit-testable without a live call). The rules it enforces:
 *
 *   • end_call while the farewell response is still being GENERATED → do
 *     nothing yet; wait for that response's end event.
 *   • Once no response is in flight → send the hangup mark EXACTLY ONCE, no
 *     matter how many lifecycle events follow.
 *   • Close only when Twilio echoes OUR mark name back (= the farewell has
 *     fully PLAYED to the caller). Any other mark name is ignored, and a stray
 *     echo before we ever sent one is ignored too.
 *   • If the echo never arrives, a fallback timer closes the call so it can
 *     never hang open. If there is no live stream to send a mark on, close
 *     immediately — there is nothing left to wait for.
 *   • onClose() (the call closed for any other reason, e.g. Twilio "stop")
 *     cancels the fallback timer so nothing fires after teardown.
 */
export function createHangupController(io: {
  /** Send the named mark on the Twilio stream. Return false when there is no
   *  live stream to wait on — the controller then closes immediately. */
  sendMark: (name: string) => boolean;
  close: (reason: string) => void;
  fallbackMs?: number;
}) {
  const fallbackMs = io.fallbackMs ?? HANGUP_FALLBACK_MS;
  let pending = false;    // end_call has been requested
  let markSent = false;   // the one hangup mark is on the wire
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stopTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const sendMarkOnce = () => {
    if (markSent) return;
    markSent = true;
    if (io.sendMark(HANGUP_MARK)) {
      timer = setTimeout(() => { timer = null; io.close("hangup_fallback_timeout"); }, fallbackMs);
    } else {
      io.close("hangup_no_live_stream");
    }
  };

  return {
    /** The end_call tool arrived. responseBusy = a response (the farewell) is
     *  still being generated — the mark must wait for its end event. */
    onEndCall(responseBusy: boolean) { pending = true; if (!responseBusy) sendMarkOnce(); },
    /** A response finished (done / cancelled). responseBusy = the coordinator
     *  still has another response in flight or queued. */
    onResponseEnded(responseBusy: boolean) { if (pending && !responseBusy) sendMarkOnce(); },
    /** Twilio echoed a mark: everything queued before it has PLAYED. */
    onMark(name: string | null) {
      if (name === HANGUP_MARK && markSent) { stopTimer(); io.close("farewell_fully_played"); }
    },
    /** The call is closing for any reason — never let the fallback fire late. */
    onClose() { stopTimer(); },
    isHangupPending(): boolean { return pending; },
  };
}


/** Pull an audio-delta payload out of an OpenAI event, tolerating name variants. Returns null if not audio. */
export function extractAudioDelta(evt: { type?: string; delta?: unknown }): string | null {
  if (
    (evt.type === "response.audio.delta" || evt.type === "response.output_audio.delta") &&
    typeof evt.delta === "string"
  ) {
    return evt.delta;
  }
  return null;
}

/** Pull a completed function call out of an OpenAI event, tolerating name variants. */
export function extractFunctionCall(
  evt: { type?: string; name?: unknown; arguments?: unknown; call_id?: unknown },
): { name: string; args: Record<string, unknown>; callId: string } | null {
  if (
    (evt.type === "response.function_call_arguments.done" ||
      evt.type === "response.output_item.done") &&
    typeof evt.name === "string" &&
    typeof evt.call_id === "string"
  ) {
    let args: Record<string, unknown> = {};
    if (typeof evt.arguments === "string") {
      try {
        args = JSON.parse(evt.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }
    }
    return { name: evt.name, args, callId: evt.call_id };
  }
  return null;
}

/** True when the caller started speaking → we should stop OpenAI playback on Twilio (barge-in). */
export function isSpeechStarted(evt: { type?: string }): boolean {
  return evt.type === "input_audio_buffer.speech_started";
}

/** The response.id an event refers to. response.created / .done / .cancelled all
 *  carry `response.id`; some error events carry a top-level `response_id`. Returns
 *  null when the event names no response. */
export function extractResponseId(evt: {
  response?: { id?: unknown };
  response_id?: unknown;
}): string | null {
  const nested = evt.response?.id;
  if (typeof nested === "string") return nested;
  if (typeof evt.response_id === "string") return evt.response_id;
  return null;
}
