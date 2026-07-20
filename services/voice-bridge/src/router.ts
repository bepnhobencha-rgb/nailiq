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
};

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
        input: {
          format: { type: "audio/pcmu" },
          turn_detection: { type: "server_vad" },
          // Transcribe the caller's speech. Without this the model still hears
          // them but emits no input transcript, so a phone call leaves no record
          // of what was said — unlike the web widget. Needed for the owner/admin
          // call-review log. The language hint matters on 8 kHz phone audio: with
          // it, transcription of the salon's primary language is far more
          // accurate; without it, Whisper auto-detects and mangles it.
          transcription: {
            model: "gpt-realtime-whisper",
            ...(cfg.transcribeLang ? { language: cfg.transcribeLang } : {}),
          },
        },
        output: {
          format: { type: "audio/pcmu" },
          voice: cfg.voice,
        },
      },
    },
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

/** Tool result back to OpenAI, then ask it to continue speaking. */
export function functionCallOutputMessages(callId: string, output: unknown): object[] {
  return [
    {
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) },
    },
    { type: "response.create" },
  ];
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
