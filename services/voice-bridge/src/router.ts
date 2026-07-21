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
// events (e.g. "connected", "mark") simply match no branch in the handler.
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
    create_response: true,
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
  if (/中文|mandarin|\b(in|to) chinese\b/.test(t)) return "zh";
  if (/tiếng việt|tieng viet|\b(in|to) vietnamese\b/.test(t)) return "vi";
  if (/\b(in|to) spanish\b|en español|en espanol|español|espanol/.test(t)) return "es";
  if (/\b(in|to) french\b|en français|en francais|français|francais/.test(t)) return "fr";
  if (/tiếng anh|\b(in|to) english\b|english please|en inglés|en ingles/.test(t)) return "en";
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
      audio: {
        input: audioInput(cfg.interruptResponse ?? true, cfg.transcribeLang),
        output: { format: { type: "audio/pcmu" }, voice: cfg.voice },
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

/** Pull a `say_this` string out of a tool result, or null. */
export function extractSayThis(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const s = (result as { say_this?: unknown }).say_this;
  return typeof s === "string" && s.trim() ? s : null;
}

/**
 * Response + barge-in lifecycle for one call. Two facts drive every decision:
 * is a response currently PLAYING, and is it PROTECTED (say_this).
 *
 *   • Twilio audio is cleared on caller speech ONLY when a response is actually
 *     playing and unprotected — never in dead air (which used to flush nothing
 *     and confuse state) and never over a protected line (echo must not cut it).
 *   • Protection is torn down on ANY response end — done, cancelled, error, or
 *     socket close — and the interrupt-restore is emitted at most once per
 *     protected episode, so overlapping events cannot leave barge-in stuck off.
 */
export function createCallLifecycle() {
  let responseActive = false;
  let protectedActive = false;
  return {
    onResponseCreated() { responseActive = true; },
    /** Call on response.done / response.cancelled / error / socket close.
     *  `restore` is true exactly once when a protected line just ended. */
    onResponseEnded(): { restore: boolean } {
      responseActive = false;
      const wasProtected = protectedActive;
      protectedActive = false;
      return { restore: wasProtected };
    },
    beginProtected() { protectedActive = true; },
    shouldClearOnSpeech(): boolean { return responseActive && !protectedActive; },
    isProtected(): boolean { return protectedActive; },
    isResponseActive(): boolean { return responseActive; },
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
