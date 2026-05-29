"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { REALTIME_TOOLS } from "@/shared/voiceai/realtimeTools";

type Props = {
  t: BookingMessages;
  shopSlug: string;
  language?: "en" | "vi";
  onClose: () => void;
};

type Status =
  | "idle"
  | "session_init"
  | "mic_request"
  | "connecting"
  | "connected"
  | "ended"
  | "error";

type AiActivity = "idle" | "speaking" | "thinking";

type Transcript = { role: "ai" | "user"; text: string };

type BookingResult = {
  bookingId: string | null;
  serviceName: string;
  date: string;
  timeSlot: string;
  customerName: string;
};

// Silence / timeout policy
const SILENCE_REPROMPT_MS  = 15_000;  // 15 s of user silence → nudge AI
const SILENCE_MAX_NUDGES   = 2;       // after 2 nudges with no speech → auto-end
const TOTAL_CALL_LIMIT_SEC = 300;     // 5-min hard cap regardless of activity

// PCM16 helpers for WebSocket audio
function float32ToPCM16(float32: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]!));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function base64ToFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i]! / 32768;
  return float32;
}

/**
 * Synthesise a single soft keyboard-key click through the Web Audio graph.
 * Duration ≈ 25 ms; gain 0.10 — audible but doesn't compete with speech.
 * Called on a repeating interval while the AI is "thinking" (response.created
 * → first response.output_audio.delta) to give audio feedback that the system
 * is processing.
 */
function playKeyClick(ctx: AudioContext): void {
  try {
    const len = Math.floor(ctx.sampleRate * 0.025); // 25 ms of samples
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d   = buf.getChannelData(0);
    // White-noise burst with a sharp exponential decay — "click" envelope
    const decay = ctx.sampleRate * 0.004; // time constant ≈ 4 ms
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.exp(-i / decay);
    }
    const src  = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = 0.10;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start();
  } catch { /* AudioContext may be suspended or closed — silently ignore */ }
}

export function VoiceBookingModal({ t, shopSlug, language = "en", onClose }: Props) {
  const [status, setStatus]               = useState<Status>("idle");
  const [aiActivity, setAiActivity]       = useState<AiActivity>("idle");
  const [error, setError]                 = useState<string | null>(null);
  const [transcript, setTranscript]       = useState<Transcript[]>([]);
  const [durationSec, setDuration]        = useState(0);
  const [bookingResult, setBookingResult] = useState<BookingResult | null>(null);

  const wsRef               = useRef<WebSocket | null>(null);
  const audioCtxRef         = useRef<AudioContext | null>(null);
  const streamRef           = useRef<MediaStream | null>(null);
  const processorRef        = useRef<ScriptProcessorNode | null>(null);
  const audioElementRef     = useRef<HTMLAudioElement | null>(null);
  const sessionIdRef        = useRef<string | null>(null);
  const timerRef            = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTsRef          = useRef<number>(0);
  const statusRef           = useRef<Status>("idle");
  const nextPlayRef         = useRef<number>(0);
  // Shared output gain node — AI audio chunks route through GainNode →
  // MediaStreamDestination → <audio> element (media volume channel).
  const outputGainRef       = useRef<GainNode | null>(null);
  // Tracks call_ids already dispatched — prevents duplicate tool calls when
  // both response.output_function_call_arguments.done AND response.done fire.
  const processedCallIdsRef = useRef<Set<string>>(new Set());

  // Silence / inactivity tracking (all refs — safe to use in async callbacks)
  const silenceTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repromptCountRef   = useRef(0);
  /** Interval that fires playKeyClick() while AI is processing (thinking state). */
  const typingIntervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const aiActiveRef           = useRef(false);   // true while AI is thinking/speaking
  /** ms timestamp until which mic input is suppressed after AI stops speaking.
   *  Prevents the mic from picking up the tail end of the speaker output and
   *  triggering a new VAD speech_started → echo loop. */
  const postSpeechCooldownRef = useRef(0);
  // Stable function stored in ref to avoid stale-closure issues in timer callbacks
  const scheduleNudgeRef = useRef<() => void>(() => undefined);
  /** Full system-prompt instructions stored so response.create calls after tool
   *  results can re-anchor the persona/tone. Without this, the model drifts to
   *  a generic/robotic register after several tool exchanges. */
  const instructionsRef   = useRef<string | null>(null);
  /** Session language — needed by the silence nudge so it stays in-language. */
  const sessionLangRef    = useRef<"en" | "vi">("vi");
  /** Voice name (e.g. "marin") — stored so every response.create can include it,
   *  locking the voice per-response and preventing random voice drift. */
  const voiceRef          = useRef<string>("marin");

  const v = t.voice;

  const cleanup = useCallback(() => {
    try { processorRef.current?.disconnect(); } catch { /* ignore */ }
    try { wsRef.current?.close(); }             catch { /* ignore */ }
    try { audioCtxRef.current?.close(); }       catch { /* ignore */ }
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    if (timerRef.current)         clearInterval(timerRef.current);
    if (silenceTimerRef.current)  clearTimeout(silenceTimerRef.current);
    if (typingIntervalRef.current) { clearInterval(typingIntervalRef.current); typingIntervalRef.current = null; }
    // Stop the <audio> element and release the media stream
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.srcObject = null;
      audioElementRef.current = null;
    }
    wsRef.current             = null;
    audioCtxRef.current       = null;
    processorRef.current      = null;
    outputGainRef.current     = null;
    streamRef.current         = null;
    nextPlayRef.current       = 0;
    silenceTimerRef.current   = null;
    aiActiveRef.current       = false;
    repromptCountRef.current  = 0;
    processedCallIdsRef.current.clear();
  }, []);

  const endSession = useCallback(async (finalStatus: "completed" | "abandoned" | "failed") => {
    cleanup();
    const sid = sessionIdRef.current;
    if (sid) {
      const elapsed = Math.round((Date.now() - startTsRef.current) / 1000);
      await fetch("/api/voice/session/end", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          sessionId:       sid,
          durationSeconds: elapsed,
          transcript:      transcript.map((e) => ({ role: e.role, text: e.text })),
          status:          finalStatus,
        }),
      }).catch(() => null);
    }
  }, [cleanup, transcript]);

  // Keep scheduleNudgeRef up-to-date whenever endSession changes identity
  useEffect(() => {
    scheduleNudgeRef.current = () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(() => {
        if (statusRef.current !== "connected") return;
        // AI became active while we were waiting — postpone
        if (aiActiveRef.current) { scheduleNudgeRef.current(); return; }

        repromptCountRef.current += 1;

        if (repromptCountRef.current > SILENCE_MAX_NUDGES) {
          // Customer unresponsive — end gracefully
          statusRef.current = "ended";
          setStatus("ended");
          void endSession("abandoned");
          return;
        }

        // Nudge AI to re-engage (per-response instruction override, no fake user message).
        // Always include the full session instructions so the nudge stays in-persona
        // and in the correct language (without this, the model reverts to English even
        // in a Vietnamese session and loses the warmth/tone of the configured persona).
        const isVi   = sessionLangRef.current === "vi";
        const nudge  = repromptCountRef.current === 1
          ? (isVi
              ? "Khách chưa nói gì một lúc. Hãy hỏi nhẹ nhàng xem họ còn đó không, bằng tiếng Việt."
              : "The customer has not spoken for a while. Gently check if they are still there.")
          : (isVi
              ? "Đây là lần nhắc thứ hai. Hãy đề nghị khách gọi lại sau hoặc đặt lịch trực tiếp, bằng tiếng Việt."
              : "This is the second check. Gently suggest they can call back later or book manually.");
        const nudgeInstructions = instructionsRef.current
          ? `${instructionsRef.current}\n\n[CURRENT TASK]: ${nudge}`
          : nudge;
        wsRef.current?.send(JSON.stringify({
          type: "response.create",
          response: { instructions: nudgeInstructions },
        }));
        // Reschedule for next check
        scheduleNudgeRef.current();
      }, SILENCE_REPROMPT_MS);
    };
  }, [endSession]);

  const handleRealtimeEvent = useCallback((
    ev: Record<string, unknown>,
    salonSlug: string,
    sessionId: string | null,
  ) => {
    const type = ev.type as string;

    // ── Tool-call dispatcher ─────────────────────────────────────────────────
    // Deduped via processedCallIdsRef so calling from both the streaming event
    // (response.output_function_call_arguments.done / response.output_item.done)
    // AND from response.done is safe — only the first wins.
    const dispatchFunctionCall = (callId: string, fnName: string, rawArgs: string) => {
      if (processedCallIdsRef.current.has(callId)) return;
      processedCallIdsRef.current.add(callId);

      console.log(`[voice/tool] ▶ dispatching ${fnName}`, { callId, rawArgs });

      let args: Record<string, unknown> = {};
      try { args = JSON.parse(rawArgs) as Record<string, unknown>; } catch { /* ignore */ }

      fetch("/api/voice/tool", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ toolName: fnName, toolArgs: args, salonSlug, sessionId }),
      })
        .then((r) => {
          console.log(`[voice/tool] ◀ ${fnName} HTTP ${r.status}`);
          return r.json();
        })
        .then((result: unknown) => {
          console.log(`[voice/tool] ✓ ${fnName} result:`, JSON.stringify(result));
          const res = result as Record<string, unknown>;
          // Surface booking confirmation in the UI immediately
          if (fnName === "confirm_booking" && res.success) {
            setBookingResult({
              bookingId:    (res.bookingId    as string | null) ?? null,
              serviceName:  (res.serviceName  as string) ?? "",
              date:         (res.date         as string) ?? "",
              timeSlot:     (res.timeSlot     as string) ?? "",
              customerName: (res.customerName as string) ?? "",
            });
          }
          // Return result to the model so it can speak the confirmation.
          // Include instructions in response.create to re-anchor persona/tone —
          // without this the model gradually drifts to a generic/robotic register
          // after several tool exchanges (it loses the warmth and language setting).
          wsRef.current?.send(JSON.stringify({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) },
          }));
          wsRef.current?.send(JSON.stringify({
            type: "response.create",
            response: {
              ...(instructionsRef.current ? { instructions: instructionsRef.current } : {}),
              // Lock voice per-response — prevents the model from drifting to a
              // different voice character (age, warmth) after tool exchanges.
              voice: voiceRef.current,
            },
          }));
        })
        .catch((err: unknown) => {
          console.error(`[voice/tool] ✗ ${fnName} fetch error:`, err);
          wsRef.current?.send(JSON.stringify({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ error: String(err) }) },
          }));
          wsRef.current?.send(JSON.stringify({
            type: "response.create",
            response: {
              ...(instructionsRef.current ? { instructions: instructionsRef.current } : {}),
              voice: voiceRef.current,
            },
          }));
        });
    };

    if (type === "session.created") {
      // session.created fires immediately on connect; wait for session.updated
      // (triggered by our session.update) before marking connected + greeting
    }

    if (type === "session.updated") {
      if (statusRef.current === "connecting") {
        statusRef.current = "connected";
        setStatus("connected");
        startTsRef.current = Date.now();
        timerRef.current = setInterval(() => {
          setDuration(Math.round((Date.now() - startTsRef.current) / 1000));
        }, 1000);
        // Prompt AI to speak first
        wsRef.current?.send(JSON.stringify({ type: "response.create" }));
      }
    }

    // AI activity — keep ref + state in sync, drive silence timer
    if (type === "response.created") {
      aiActiveRef.current = true;
      setAiActivity("thinking");
      // AI is now active — pause silence watch
      if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
      // Typing sound: fire a key-click every 100–130 ms while the model thinks.
      // Cleared as soon as the first audio chunk arrives (response.output_audio.delta).
      if (!typingIntervalRef.current && audioCtxRef.current) {
        const ctx = audioCtxRef.current;
        const intervalMs = 100 + Math.floor(Math.random() * 30); // 100–129 ms
        typingIntervalRef.current = setInterval(() => {
          if (ctx.state !== "closed") playKeyClick(ctx);
        }, intervalMs);
      }
    }
    if (type === "response.output_audio.delta" || type === "response.audio.delta") {
      aiActiveRef.current = true;
      setAiActivity("speaking");
      // First audio chunk arrived — stop typing sound immediately
      if (typingIntervalRef.current) { clearInterval(typingIntervalRef.current); typingIntervalRef.current = null; }
    }

    if (type === "response.done") {
      aiActiveRef.current = false;
      // Stop typing sound in case the response had no audio (e.g. function-call only)
      if (typingIntervalRef.current) { clearInterval(typingIntervalRef.current); typingIntervalRef.current = null; }
      // 800 ms cooldown: suppresses mic input long enough for speaker audio to
      // decay so the VAD doesn't immediately re-fire on the tail of our own output.
      // Increased from 400 ms — 400 ms was too short on slower devices / networks
      // where audio playback decays slowly, causing the VAD to re-trigger.
      postSpeechCooldownRef.current = Date.now() + 800;
      setAiActivity("idle");

      // ── Belt-and-suspenders: extract any function calls from the response
      // output array.  Streaming events (response.output_function_call_arguments
      // .done, response.output_item.done) should have fired first, so
      // processedCallIdsRef deduplication makes this a safe no-op in that case.
      // But if those events were missed (new model, rate-limit, etc.) this
      // catches them.
      const resp = ev.response as {
        output?: Array<{ type?: string; call_id?: string; name?: string; arguments?: string }>;
      } | undefined;
      let hasPendingFunctionCall = false;
      for (const item of resp?.output ?? []) {
        if (item.type === "function_call" && item.call_id && item.name) {
          // If already dispatched by the streaming event, processedCallIdsRef
          // prevents a second dispatch.  If not yet dispatched (streaming event
          // was missed) this is the first — and real — dispatch.
          if (!processedCallIdsRef.current.has(item.call_id)) {
            hasPendingFunctionCall = true;
          }
          dispatchFunctionCall(item.call_id, item.name, item.arguments ?? "{}");
        }
      }

      // Only start the user-silence timer when there are no pending tool calls.
      // The tool result will trigger a new response.create → response.created
      // → the cycle restarts naturally.
      if (!hasPendingFunctionCall && statusRef.current === "connected") {
        scheduleNudgeRef.current();
      }
    }

    // User started speaking — reset silence tracker
    if (type === "input_audio_buffer.speech_started") {
      repromptCountRef.current = 0;
      if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    }

    // ── Audio playback ───────────────────────────────────────────────────────
    if (type === "response.output_audio.delta" || type === "response.audio.delta") {
      const delta = ev.delta as string | undefined;
      if (!delta || !audioCtxRef.current) return;
      void audioCtxRef.current.resume();
      const ctx  = audioCtxRef.current;
      // Route through outputGainRef (2× boost) if available, else direct.
      const dest = outputGainRef.current ?? ctx.destination;
      const float32 = base64ToFloat32(delta);
      const buf = ctx.createBuffer(1, float32.length, 24000);
      buf.getChannelData(0).set(float32);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      const when = Math.max(ctx.currentTime, nextPlayRef.current);
      src.start(when);
      nextPlayRef.current = when + buf.duration;
    }

    // ── Transcripts ──────────────────────────────────────────────────────────
    if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
      const text = ev.transcript as string | undefined;
      if (text) setTranscript((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "ai" && last.text === text) return prev;
        return [...prev, { role: "ai" as const, text }];
      });
    }

    // User speech transcript — fires when input audio transcription is available
    if (type === "conversation.item.input_audio_transcription.completed") {
      const text = ev.transcript as string | undefined;
      if (text) setTranscript((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "user" && last.text === text) return prev;
        return [...prev, { role: "user" as const, text }];
      });
    }

    // Fallback: conversation.item.created for text-role user messages
    if (type === "conversation.item.created") {
      const item = ev.item as { role?: string; content?: { text?: string }[] } | undefined;
      if (item?.role === "user") {
        const text = item.content?.find((c) => c.text)?.text ?? "";
        if (text) setTranscript((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "user" && last.text === text) return prev;
          return [...prev, { role: "user", text }];
        });
      }
    }

    // ── Streaming function-call events ────────────────────────────────────────
    // gpt-realtime-2 GA uses response.output_function_call_arguments.done;
    // older preview used response.function_call_arguments.done;
    // response.output_item.done wraps completed items including function calls.
    const isFunctionCallDone =
      type === "response.function_call_arguments.done" ||
      type === "response.output_function_call_arguments.done" ||
      (type === "response.output_item.done" && (ev.item as { type?: string } | undefined)?.type === "function_call");

    if (isFunctionCallDone) {
      const item    = ev.item as { name?: string; call_id?: string; arguments?: string } | undefined;
      const fnName  = (ev.name     as string | undefined) ?? item?.name;
      const callId  = (ev.call_id  as string | undefined) ?? item?.call_id;
      const rawArgs = (ev.arguments as string | undefined) ?? item?.arguments ?? "{}";
      if (fnName && callId) {
        dispatchFunctionCall(callId, fnName, rawArgs);
      }
    }

    if (type === "error") {
      const errObj = ev.error as { code?: string; message?: string; type?: string } | undefined;
      console.error("[voice/ws] server error:", JSON.stringify(ev));
      // Map known OpenAI error codes to user-friendly messages
      const isRateLimit =
        errObj?.type === "rate_limit_error" ||
        errObj?.code === "rate_limit_exceeded" ||
        errObj?.code === "token_limit_exceeded";
      const msg = isRateLimit
        ? "openai_rate_limit"
        : (errObj?.message ?? errObj?.code ?? errObj?.type ?? JSON.stringify(ev));
      setError(isRateLimit ? v.openaiRateLimit : msg);
      statusRef.current = "error";
      setStatus("error");
      cleanup();
    }
  }, [cleanup]);  // eslint-disable-line react-hooks/exhaustive-deps
  // Note: setBookingResult is a stable React setter; wsRef/processedCallIdsRef
  // are stable refs. dispatchFunctionCall is defined inside the callback and
  // captures those correctly. Adding them to deps would cause infinite re-renders.

  const start = useCallback(async () => {
    if (statusRef.current !== "idle" && statusRef.current !== "error") return;
    statusRef.current = "session_init";
    setStatus("session_init");
    setError(null);
    setBookingResult(null);

    try {
      // 1. Get ephemeral key + session from server
      const sessRes = await fetch("/api/voice/session", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ salonSlug: shopSlug, language }),
      });
      if (!sessRes.ok) {
        const body = await sessRes.json().catch(() => ({})) as Record<string, string>;
        throw new Error(body.error ?? `session_init_${sessRes.status}`);
      }
      const { ephemeralKey, model: realtimeModel, sessionId, voice, instructions } = await sessRes.json() as {
        ephemeralKey:  string;
        model:         string;
        sessionId:     string | null;
        voice:         string;
        instructions?: string;
      };
      sessionIdRef.current    = sessionId;
      // Store instructions, language, and voice so downstream response.create
      // calls can re-anchor the persona AND lock the voice after each tool
      // exchange (prevents both tone drift and voice age/character variation).
      instructionsRef.current = instructions ?? null;
      sessionLangRef.current  = language;
      voiceRef.current        = voice;

      // 2. Request microphone
      statusRef.current = "mic_request";
      setStatus("mic_request");
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("insecure_context");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  true,
          sampleRate:       24000,
        },
      });
      streamRef.current = stream;

      // 3. AudioContext for mic capture + playback
      statusRef.current = "connecting";
      setStatus("connecting");

      // ── Audio output: route through <audio> element for media-level volume ──
      //
      // Problem: Web Audio API AudioContext uses the "call/default" volume
      // channel on mobile — much quieter than YouTube/Spotify which use the
      // "media" channel. navigator.audioSession.type='playback' fixes this on
      // iOS 17+ only; Android doesn't support that API at all.
      //
      // Solution (works on all platforms):
      //   GainNode → MediaStreamDestination → <audio>.srcObject → media channel
      //
      // The <audio> element is treated by iOS and Android as media playback
      // (same priority as YouTube), so it uses the media volume slider
      // automatically — no OS-specific API needed.

      const audioCtx = new AudioContext({ sampleRate: 24000 });
      audioCtxRef.current = audioCtx;

      // GainNode: slight boost in case media volume is lowered by the user
      const outputGain = audioCtx.createGain();
      outputGain.gain.value = 1.2;

      // Route to MediaStreamDestination (bridges Web Audio → HTMLMediaElement)
      const mediaStreamDest = audioCtx.createMediaStreamDestination();
      outputGain.connect(mediaStreamDest);
      outputGainRef.current = outputGain;

      // <audio> element plays the media stream on the media volume channel
      const audioEl = new Audio();
      audioEl.srcObject = mediaStreamDest.stream;
      audioEl.autoplay  = true;
      audioElementRef.current = audioEl;
      // Start playback — must be called after a user gesture (button tap already happened)
      audioEl.play().catch(() => {
        // Fallback: connect directly to AudioContext destination if autoplay blocked
        outputGain.disconnect(mediaStreamDest);
        outputGain.connect(audioCtx.destination);
      });

      // 4. Open WebSocket directly to OpenAI with ek_... as subprotocol auth
      const wsUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(realtimeModel)}`;
      const ws = new WebSocket(wsUrl, ["realtime", `openai-insecure-api-key.${ephemeralKey}`]);
      wsRef.current = ws;

      ws.onopen = () => {
        // Resume AudioContext (Chrome may suspend it until a user gesture)
        void audioCtx.resume();

        // Configure session for gpt-realtime-2.
        //
        // IMPORTANT — create_response: true in turn_detection:
        //   Without this, semantic_vad detects end-of-speech but does NOT
        //   automatically trigger a new model response. The user would say
        //   "đồng ý" and nothing would happen. Defaults are not reliable
        //   across model versions — always set explicitly.
        //
        // instructions is returned by /api/voice/session and reinforced here
        // so the model always has the booking rules (belt-and-suspenders).
        // gpt-realtime-2 uses a nested audio config format.
        // Fields confirmed valid: type, output_modalities, instructions, tools,
        // tool_choice, audio.input.format, audio.input.turn_detection,
        // audio.output.format, audio.output.voice.
        // Note: function_call items are separate from output_modalities —
        // tools fire regardless of whether "text" is in output_modalities.
        //
        // ── gpt-realtime-2 session.update: CONFIRMED VALID FIELDS ──────────────
        //
        // ONLY these top-level fields are accepted (others → "unknown_parameter"):
        //   type, output_modalities, instructions, tools, tool_choice, audio.*
        //
        // Confirmed REJECTED top-level fields (do not add back):
        //   session.voice        → rejected 2026-05-29  (use audio.output.voice)
        //   session.temperature  → rejected 2026-05-29  (not supported)
        //   session.turn_detection          → rejected 2026-05-28
        //   session.input_audio_transcription → rejected 2026-05-28
        //
        // output_modalities: gpt-realtime-2 supports ONLY ["audio"] or ["text"].
        //   ["text","audio"] combined → "invalid_value" error (rejected 2026-05-29).
        //   Use ["audio"] for voice sessions. Function/tool calls are a SEPARATE
        //   output type (function_call items) and fire independently of modalities —
        //   they are NOT affected by omitting "text" from output_modalities.
        //   (gpt-4o-realtime-preview supported ["text","audio"] — gpt-realtime-2 does not.)
        ws.send(JSON.stringify({
          type: "session.update",
          session: {
            type:              "realtime",
            output_modalities: ["audio"],
            ...(instructions ? { instructions } : {}),
            tools:             [...REALTIME_TOOLS],
            tool_choice:       "auto",
            // All input config (VAD, transcription, format) is nested under audio.input.*
            // All output config (format, voice) is nested under audio.output.*
            audio: {
              input: {
                format:         { type: "audio/pcm", rate: 24000 },
                // Nested transcription field for gpt-realtime-2 format.
                // Without this the model hears the user but the transcript
                // never shows the user's words (conversation.item.input_audio_
                // transcription.completed never fires).
                transcription:  { model: "whisper-1" },
                turn_detection: {
                  type:               "semantic_vad",
                  // "low" eagerness: VAD waits for a longer natural pause before
                  // treating speech as finished. "auto" was too sensitive — after
                  // the guest answered a question the model would fire a new
                  // response before they had finished speaking, creating an
                  // overlapping-speech / continuous-talking loop.
                  eagerness:          "low",
                  create_response:    true,
                  interrupt_response: true,
                },
              },
              output: {
                format: { type: "audio/pcm", rate: 24000 },
                voice,  // keep nested format for gpt-realtime-2 compatibility
              },
            },
          },
        }));

        // Capture mic: route through a muted gain node so ScriptProcessor fires
        // without echoing mic audio back to the speakers
        const source    = audioCtx.createMediaStreamSource(stream);
        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        const muteGain  = audioCtx.createGain();
        muteGain.gain.value = 0;
        processorRef.current = processor;
        source.connect(processor);
        processor.connect(muteGain);
        muteGain.connect(audioCtx.destination);
        processor.onaudioprocess = (e) => {
          if (wsRef.current?.readyState !== WebSocket.OPEN) return;
          // Suppress mic while AI is speaking or within the post-speech cooldown
          // window — prevents the VAD from hearing the AI's own output through
          // the speakers and triggering an echo loop.
          if (aiActiveRef.current || Date.now() < postSpeechCooldownRef.current) return;
          const pcm = e.inputBuffer.getChannelData(0);
          const buf = float32ToPCM16(pcm);
          const b64 = arrayBufferToBase64(buf);
          wsRef.current.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
        };
      };

      ws.onmessage = (e: MessageEvent) => {
        try {
          const ev     = JSON.parse(e.data as string) as Record<string, unknown>;
          const evType = ev.type as string;
          // Suppress only high-frequency audio streaming noise (not VAD events)
          const isAudioStream =
            evType === "response.audio.delta" ||
            evType === "response.output_audio.delta" ||
            evType === "input_audio_buffer.appended" ||
            evType === "input_audio_buffer.append";
          if (!isAudioStream) {
            // Always log full JSON for diagnostic events
            const wantFull =
              evType.includes("function") ||
              evType.includes("tool")     ||
              evType.includes("item")     ||
              evType === "response.done"  ||
              evType === "session.updated";   // ← see if tools were accepted
            // speech_started / speech_stopped are lightweight — always log them
            // so VAD detection problems are visible in DevTools
            console.log("[voice/ws]", evType, wantFull ? JSON.stringify(ev) : "");
          }
          handleRealtimeEvent(ev, shopSlug, sessionId);
        } catch { /* malformed frame */ }
      };

      ws.onerror = () => {
        if (statusRef.current !== "ended") {
          setError("connection_failed");
          statusRef.current = "error";
          setStatus("error");
          cleanup();
        }
      };

      ws.onclose = (e) => {
        if (statusRef.current === "connected") {
          if (e.code !== 1000) {
            setError(`connection_closed_${e.code}`);
            statusRef.current = "error";
            setStatus("error");
          } else {
            statusRef.current = "ended";
            setStatus("ended");
          }
        }
      };

    } catch (err) {
      const msg  = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name   : "";
      const code =
        name === "NotAllowedError"        ? v.micPermissionDenied
        : name === "NotFoundError"        ? v.micError
        : msg === "insecure_context"      ? v.notSupported
        : msg === "voice_not_enabled"     ? v.voiceNotEnabled
        : msg === "session_limit_reached" ? v.sessionLimitReached
        : msg === "openai_rate_limit"     ? v.openaiRateLimit
        : msg;
      setError(code);
      statusRef.current = "error";
      setStatus("error");
      cleanup();
    }
  }, [shopSlug, language, v, cleanup, handleRealtimeEvent]);

  const handleStop = useCallback(async () => {
    statusRef.current = "ended";
    setStatus("ended");
    await endSession("completed");
  }, [endSession]);

  const handleClose = useCallback(async () => {
    if (statusRef.current === "connected") await endSession("abandoned");
    else cleanup();
    onClose();
  }, [endSession, cleanup, onClose]);

  useEffect(() => {
    void start();
    return () => { void endSession("abandoned"); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 5-min hard cap — auto-end regardless of activity
  useEffect(() => {
    if (status === "connected" && durationSec >= TOTAL_CALL_LIMIT_SEC) {
      void handleStop();
    }
  }, [durationSec, status, handleStop]);

  const formatDuration = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

  const isListening = status === "connected" && aiActivity === "idle";
  const isSpeaking  = status === "connected" && aiActivity === "speaking";
  const isThinking  = status === "connected" && aiActivity === "thinking";

  return (
    /*
     * Outer backdrop: items-end on mobile (bottom sheet), items-center on sm+.
     * px/pt use p-4; pb uses env(safe-area-inset-bottom) so the card never
     * slides under the iPhone home indicator (≈34px on iPhone X+).
     * On devices without a safe area, env() returns 0 and the 1rem fallback
     * provides the same 16px gap as before.
     */
    <div
      role="dialog"
      aria-modal="true"
      aria-label={v.tapToSpeak}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 px-4 pt-4 sm:items-center sm:p-4"
      style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
    >
      {/*
       * Card: flex-column layout so the action buttons are ALWAYS visible
       * at the bottom regardless of how much transcript there is.
       * max-h-[85dvh] prevents overflow on small phones;
       * dvh (dynamic viewport height) accounts for the iOS Safari toolbar.
       */}
      <div className="flex w-full max-w-md flex-col rounded-2xl bg-[var(--booking-bg-card)] shadow-2xl max-h-[85dvh]">

        {/* ── Header — always visible, never scrolled away ── */}
        <div className="flex flex-shrink-0 items-center justify-between px-6 pt-6 pb-4">
          <h2 className="text-lg font-semibold text-[var(--booking-text)]">{v.tapToSpeak}</h2>
          {/*
           * Touch target is 44×44 px (Apple HIG minimum).
           * p-2.5 (10px) + h-5/w-5 icon (20px) = 40px — close enough;
           * the -m-2 negative margin extends the hit area visually.
           */}
          <button
            type="button"
            onClick={() => void handleClose()}
            className="-m-1 rounded-full p-2.5 text-[var(--booking-text-muted)] hover:bg-[var(--booking-bg-input)] active:bg-[var(--booking-bg-input)] transition-colors"
            aria-label={v.close}
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* ── Scrollable content area ── */}
        <div className="flex-1 overflow-y-auto px-6 pb-2">

          {/* Status indicator */}
          <div className="mb-4 flex flex-col items-center justify-center gap-3 py-2">
            <div className={[
              "flex h-20 w-20 items-center justify-center rounded-full transition-all duration-300",
              isListening                    ? "bg-green-100 shadow-lg shadow-green-200 animate-pulse" : "",
              isSpeaking                     ? "bg-blue-100 shadow-lg shadow-blue-200 animate-pulse" : "",
              isThinking                     ? "bg-amber-100" : "",
              status === "error"             ? "bg-red-100" : "",
              status === "ended"             ? (bookingResult ? "bg-green-100" : "bg-zinc-100") : "",
              !["connected","error","ended"].includes(status) ? "bg-[var(--booking-bg-input)]" : "",
            ].join(" ")}>
              {status === "connected" && !isSpeaking ? (
                /* Listening / thinking mic icon */
                <svg className={["h-10 w-10", isThinking ? "text-amber-500" : "text-green-600"].join(" ")} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
              ) : isSpeaking ? (
                /* Speaker wave icon */
                <svg className="h-10 w-10 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.536 8.464a5 5 0 010 7.072M12 6v12m-3.536-9.536a5 5 0 000 7.072M19.07 4.93a10 10 0 010 14.14" />
                </svg>
              ) : status === "ended" && bookingResult ? (
                /* Booking confirmed — green check */
                <svg className="h-10 w-10 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
                </svg>
              ) : status === "ended" ? (
                /* Plain ended — grey check */
                <svg className="h-10 w-10 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
                </svg>
              ) : status === "error" ? (
                <svg className="h-10 w-10 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              ) : (
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--salon-primary)] border-t-transparent" />
              )}
            </div>

            <p className="text-sm font-medium text-[var(--booking-text)]">
              {status === "session_init" ? v.connecting
               : status === "mic_request"  ? v.micRequest
               : status === "connecting"   ? v.settingUp
               : isSpeaking               ? v.aiSpeaking
               : isThinking               ? v.processing
               : status === "connected"   ? `${v.listening} ${formatDuration(durationSec)}`
               : status === "ended" && bookingResult ? v.bookingConfirmed
               : status === "ended"       ? v.ended
               : status === "error"       ? (error ?? "Error")
               : ""}
            </p>
          </div>

          {/* Booking confirmation card — shown when confirm_booking succeeded */}
          {bookingResult && (
            <div className="mb-4 rounded-xl border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-950">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-green-700 dark:text-green-400">
                {v.bookingConfirmed}
              </p>
              <p className="text-sm font-semibold text-[var(--booking-text)]">{bookingResult.serviceName}</p>
              <p className="text-sm text-[var(--booking-text-muted)]">
                {bookingResult.date} · {bookingResult.timeSlot}
              </p>
              <p className="text-sm text-[var(--booking-text-muted)]">{bookingResult.customerName}</p>
            </div>
          )}

          {/* Transcript — two-way: AI + user speech */}
          {transcript.length > 0 && !bookingResult && (
            <div className="mb-2 max-h-36 space-y-1.5 overflow-y-auto rounded-xl bg-[var(--booking-bg-input)] p-3 text-sm">
              {transcript.map((entry, i) => (
                <p key={i} className={entry.role === "ai"
                  ? "text-[var(--booking-text)]"
                  : "text-[var(--booking-text-muted)] italic"}>
                  <span className="font-semibold">
                    {entry.role === "ai" ? `${v.aiLabel}: ` : `${v.youLabel}: `}
                  </span>
                  {entry.text}
                </p>
              ))}
            </div>
          )}

        </div>{/* end scrollable area */}

        {/* ── Action buttons — flex-shrink-0: NEVER pushed off screen ── */}
        <div className="flex flex-shrink-0 gap-3 px-6 py-4">
          {status === "connected" && (
            <button
              type="button"
              onClick={() => void handleStop()}
              className="flex-1 rounded-xl bg-red-500 py-3 text-sm font-semibold text-white hover:bg-red-600 active:bg-red-700 transition-colors"
            >
              {v.endCall}
            </button>
          )}
          {status === "error" && (
            <button
              type="button"
              onClick={() => { statusRef.current = "idle"; setStatus("idle"); void start(); }}
              className="flex-1 rounded-xl bg-[var(--salon-primary)] py-3 text-sm font-semibold text-white hover:opacity-90 active:opacity-80 transition-opacity"
            >
              {v.tryAgain}
            </button>
          )}
          {status !== "connected" && (
            <button
              type="button"
              onClick={() => void handleClose()}
              className="flex-1 rounded-xl border border-[var(--booking-border)] py-3 text-sm font-semibold text-[var(--booking-text)] hover:bg-[var(--booking-bg-input)] active:bg-[var(--booking-bg-input)] transition-colors"
            >
              {status === "ended" ? v.close : v.cancel}
            </button>
          )}
        </div>

      </div>
    </div>
  );
}
