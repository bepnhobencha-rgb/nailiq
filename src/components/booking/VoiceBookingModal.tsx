"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BookingMessages } from "@/shared/i18n/booking/en";

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

type Transcript = { role: "ai" | "user"; text: string };

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

export function VoiceBookingModal({ t, shopSlug, language = "en", onClose }: Props) {
  const [status, setStatus]         = useState<Status>("idle");
  const [error, setError]           = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Transcript[]>([]);
  const [durationSec, setDuration]  = useState(0);

  const wsRef          = useRef<WebSocket | null>(null);
  const audioCtxRef    = useRef<AudioContext | null>(null);
  const streamRef      = useRef<MediaStream | null>(null);
  const processorRef   = useRef<ScriptProcessorNode | null>(null);
  const sessionIdRef   = useRef<string | null>(null);
  const timerRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTsRef     = useRef<number>(0);
  const statusRef      = useRef<Status>("idle");
  const nextPlayRef    = useRef<number>(0);

  const v = t.voice;

  const cleanup = useCallback(() => {
    try { processorRef.current?.disconnect(); } catch { /* ignore */ }
    try { wsRef.current?.close(); }             catch { /* ignore */ }
    try { audioCtxRef.current?.close(); }       catch { /* ignore */ }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (timerRef.current) clearInterval(timerRef.current);
    wsRef.current      = null;
    audioCtxRef.current = null;
    processorRef.current = null;
    streamRef.current  = null;
    nextPlayRef.current = 0;
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

  const handleRealtimeEvent = useCallback((
    ev: Record<string, unknown>,
    salonSlug: string,
    sessionId: string | null,
  ) => {
    const type = ev.type as string;

    if (type === "session.created" || type === "session.updated") {
      // Session is active — mark connected
      if (statusRef.current === "connecting") {
        statusRef.current = "connected";
        setStatus("connected");
        startTsRef.current = Date.now();
        timerRef.current = setInterval(() => {
          setDuration(Math.round((Date.now() - startTsRef.current) / 1000));
        }, 1000);
      }
    }

    if (type === "response.audio.delta") {
      const delta = ev.delta as string | undefined;
      if (!delta || !audioCtxRef.current) return;
      const ctx = audioCtxRef.current;
      const float32 = base64ToFloat32(delta);
      const buf = ctx.createBuffer(1, float32.length, 24000);
      buf.getChannelData(0).set(float32);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const when = Math.max(ctx.currentTime, nextPlayRef.current);
      src.start(when);
      nextPlayRef.current = when + buf.duration;
    }

    if (type === "response.audio_transcript.done") {
      const text = ev.transcript as string | undefined;
      if (text) setTranscript((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "ai" && last.text === text) return prev;
        return [...prev, { role: "ai" as const, text }];
      });
    }

    if (type === "conversation.item.created") {
      const item = ev.item as { role?: string; content?: { text?: string }[] } | undefined;
      if (item?.role === "user") {
        const text = item.content?.find((c) => c.text)?.text ?? "";
        if (text) setTranscript((prev) => [...prev, { role: "user", text }]);
      }
    }

    if (type === "response.function_call_arguments.done") {
      const name    = ev.name    as string | undefined;
      const call_id = ev.call_id as string | undefined;
      if (!name || !call_id) return;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(ev.arguments as string ?? "{}") as Record<string, unknown>; } catch { /* ignore */ }

      fetch("/api/voice/tool", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ toolName: name, toolArgs: args, salonSlug, sessionId }),
      })
        .then((r) => r.json())
        .then((result) => {
          wsRef.current?.send(JSON.stringify({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id, output: JSON.stringify(result) },
          }));
          wsRef.current?.send(JSON.stringify({ type: "response.create" }));
        })
        .catch((err: unknown) => {
          wsRef.current?.send(JSON.stringify({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id, output: JSON.stringify({ error: String(err) }) },
          }));
          wsRef.current?.send(JSON.stringify({ type: "response.create" }));
        });
    }

    if (type === "error") {
      console.error("[voice/ws] server error:", ev);
    }
  }, []);

  const start = useCallback(async () => {
    if (statusRef.current !== "idle" && statusRef.current !== "error") return;
    statusRef.current = "session_init";
    setStatus("session_init");
    setError(null);

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
      const { ephemeralKey, model: realtimeModel, sessionId, voice } = await sessRes.json() as {
        ephemeralKey:  string;
        model:         string;
        sessionId:     string | null;
        voice:         string;
      };
      sessionIdRef.current = sessionId;

      // 2. Request microphone
      statusRef.current = "mic_request";
      setStatus("mic_request");
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("insecure_context");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // 3. AudioContext for mic capture + playback
      statusRef.current = "connecting";
      setStatus("connecting");
      const audioCtx = new AudioContext({ sampleRate: 24000 });
      audioCtxRef.current = audioCtx;

      // 4. Open WebSocket directly to OpenAI with ek_... as subprotocol auth
      const wsUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(realtimeModel)}`;
      const ws = new WebSocket(wsUrl, ["realtime", `openai-insecure-api-key.${ephemeralKey}`]);
      wsRef.current = ws;

      ws.onopen = () => {
        // Configure session
        ws.send(JSON.stringify({
          type: "session.update",
          session: {
            voice,
            modalities:                ["audio", "text"],
            input_audio_format:        "pcm16",
            output_audio_format:       "pcm16",
            input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
            turn_detection: {
              type:                "server_vad",
              threshold:           0.45,
              prefix_padding_ms:   200,
              silence_duration_ms: 700,
            },
          },
        }));

        // Start streaming mic audio
        const source    = audioCtx.createMediaStreamSource(stream);
        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;
        source.connect(processor);
        processor.connect(audioCtx.destination);
        processor.onaudioprocess = (e) => {
          if (wsRef.current?.readyState !== WebSocket.OPEN) return;
          const pcm  = e.inputBuffer.getChannelData(0);
          const buf  = float32ToPCM16(pcm);
          const b64  = arrayBufferToBase64(buf);
          wsRef.current.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
        };
      };

      ws.onmessage = (e: MessageEvent) => {
        try {
          const ev = JSON.parse(e.data as string) as Record<string, unknown>;
          handleRealtimeEvent(ev, shopSlug, sessionId);
        } catch { /* malformed */ }
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
        name === "NotAllowedError"    ? v.micPermissionDenied
        : name === "NotFoundError"    ? v.micError
        : msg === "insecure_context"  ? v.notSupported
        : msg === "voice_not_enabled" ? "Voice AI is not enabled for this salon."
        : msg === "session_limit_reached" ? "Voice sessions limit reached for this month."
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

  const formatDuration = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Voice booking"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl dark:bg-zinc-900">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[var(--booking-text)]">{v.tapToSpeak}</h2>
          <button
            type="button"
            onClick={() => void handleClose()}
            className="rounded-full p-1.5 text-[var(--booking-text-muted)] hover:bg-[var(--booking-bg-card)] transition-colors"
            aria-label="Close"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Status indicator */}
        <div className="mb-4 flex flex-col items-center justify-center gap-3 py-4">
          <div className={[
            "flex h-20 w-20 items-center justify-center rounded-full transition-all",
            status === "connected"   ? "bg-green-100 shadow-lg shadow-green-200 animate-pulse" : "",
            status === "error"       ? "bg-red-100"   : "",
            status === "ended"       ? "bg-zinc-100"  : "",
            !["connected","error","ended"].includes(status) ? "bg-[var(--booking-bg-card)]" : "",
          ].join(" ")}>
            {status === "connected" ? (
              <svg className="h-10 w-10 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
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
            {status === "session_init" ? "Connecting…"
             : status === "mic_request"  ? "Requesting microphone…"
             : status === "connecting"   ? "Setting up connection…"
             : status === "connected"    ? `${v.listening} ${formatDuration(durationSec)}`
             : status === "ended"        ? v.done
             : status === "error"        ? (error ?? "Error")
             : ""}
          </p>
        </div>

        {/* Transcript */}
        {transcript.length > 0 && (
          <div className="mb-4 max-h-40 space-y-2 overflow-y-auto rounded-xl bg-[var(--booking-bg-card)] p-3 text-sm">
            {transcript.map((entry, i) => (
              <p key={i} className={entry.role === "ai" ? "text-[var(--booking-text)]" : "text-[var(--booking-text-muted)] italic"}>
                <span className="font-semibold">{entry.role === "ai" ? "AI: " : "You: "}</span>
                {entry.text}
              </p>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          {status === "connected" && (
            <button
              type="button"
              onClick={() => void handleStop()}
              className="flex-1 rounded-xl bg-red-500 py-3 text-sm font-semibold text-white hover:bg-red-600 transition-colors"
            >
              End Call
            </button>
          )}
          {status === "error" && (
            <button
              type="button"
              onClick={() => { statusRef.current = "idle"; setStatus("idle"); void start(); }}
              className="flex-1 rounded-xl bg-[var(--salon-primary)] py-3 text-sm font-semibold text-white hover:opacity-90 transition-opacity"
            >
              Try Again
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleClose()}
            className="flex-1 rounded-xl border border-[var(--booking-border)] py-3 text-sm font-semibold text-[var(--booking-text)] hover:bg-[var(--booking-bg-card)] transition-colors"
          >
            {status === "ended" ? "Close" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
