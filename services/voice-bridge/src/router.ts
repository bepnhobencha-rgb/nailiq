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
  if (/中文/.test(t) || /\b(?:in|to) (?:chinese|mandarin)\b/.test(t) || asksFor("chinese|mandarin")) return "zh";
  if (/tiếng việt|tieng viet/.test(t) || /\b(?:in|to) vietnamese\b/.test(t) || asksFor("vietnamese")) return "vi";
  if (/\b(?:in|to) spanish\b|en español|en espanol|español|espanol/.test(t) || asksFor("spanish")) return "es";
  if (/\b(?:in|to) french\b|en français|en francais|français|francais/.test(t) || asksFor("french")) return "fr";
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
    if (closed || activeId !== null || awaiting !== null) return; // one at a time
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
    onResponseEnded(id: string) {
      if (activeId === null || id !== activeId) return; // wrong id → never end another response
      const wasProtected = activeKind === "protected";
      const lang = activeLang;
      activeId = null; activeKind = null;
      if (wasProtected) send(interruptToggleMessage(true, lang)); // restore only for the matching protected line
      pump();
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
