"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { REALTIME_CONFIG } from "@/config/realtime";
import { VOICE_TOOLS } from "@/shared/voice/tools";

// ─── Error serialization ────────────────────────────────────────────────────
// JSON.stringify(new Error("x")) === "{}" — always use this instead.

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const base: Record<string, unknown> = {
      name: err.name,
      message: err.message,
      stack: err.stack ?? null,
      cause: err.cause != null ? serializeError(err.cause) : null,
    };
    // Capture any custom properties attached to the Error (e.g. _sdpPayload)
    for (const key of Object.getOwnPropertyNames(err)) {
      if (!(key in base)) {
        base[key] = (err as unknown as Record<string, unknown>)[key];
      }
    }
    return base;
  }
  if (typeof err === "object" && err !== null) {
    return err as Record<string, unknown>;
  }
  return { raw: String(err) };
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type DebugMode = "safe" | "tool" | "full";
export type EventDirection = "in" | "out" | "system";

export type LoggedEvent = {
  id: string;
  direction: EventDirection;
  type: string;
  ts: number;      // absolute ms timestamp
  relMs: number;   // ms since session start
  payload: unknown;
};

export type ConnectionStats = {
  ice: RTCIceConnectionState | null;
  pc: RTCPeerConnectionState | null;
  dc: RTCDataChannelState | null;
  signaling: RTCSignalingState | null;
};

export type LatencyMeasurement = { type: "stt" | "response"; ms: number; ts: number };

export type RegressionTest = {
  id: string;
  name: string;
  input: string;
  expectedToolName?: string;
  expectedArgsSubset?: Record<string, unknown>;
  timeoutMs?: number;
};

export type RegressionResult = {
  test: RegressionTest;
  passed: boolean;
  actualToolName?: string;
  actualArgs?: Record<string, unknown>;
  error?: string;
  durationMs: number;
};

export type SessionExport = {
  id: string;
  mode: DebugMode;
  salon: string;
  language: string;
  startedAt: number;
  endedAt: number | null;
  events: LoggedEvent[];
  latency: LatencyMeasurement[];
};

export type VoiceDebugStatus =
  | "idle" | "connecting_mic" | "connecting_openai" | "connecting_dc"
  | "ready" | "listening" | "thinking" | "speaking"
  | "tool_calling" | "confirmed" | "ended" | "error";

export type UseVoiceDebugReturn = {
  status: VoiceDebugStatus;
  mode: DebugMode;
  connectionStats: ConnectionStats;
  errorMessage: string | null;
  userTranscript: string;
  aiMessage: string;
  messages: { role: "user" | "assistant"; text: string; ts: number }[];
  eventLog: LoggedEvent[];
  latencyLog: LatencyMeasurement[];
  setMode: (mode: DebugMode) => void;
  start: (shopSlug: string, language: "en" | "vi") => Promise<void>;
  end: () => void;
  injectText: (text: string) => void;
  clearLog: () => void;
  exportSession: () => string;
  runTest: (test: RegressionTest) => Promise<RegressionResult>;
};

type RealtimeEvent = { type: string; [key: string]: unknown };
type SessionConfig = { instructions: string; voice: string; tools: unknown[] };

// ─── Hook ──────────────────────────────────────────────────────────────────

export function useVoiceDebug(): UseVoiceDebugReturn {
  const [status, setStatus] = useState<VoiceDebugStatus>("idle");
  const [mode, setMode] = useState<DebugMode>("full");
  const [connectionStats, setConnectionStats] = useState<ConnectionStats>({
    ice: null, pc: null, dc: null, signaling: null,
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [userTranscript, setUserTranscript] = useState("");
  const [aiMessage, setAiMessage] = useState("");
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; text: string; ts: number }[]>([]);
  const [eventLog, setEventLog] = useState<LoggedEvent[]>([]);
  const [latencyLog, setLatencyLog] = useState<LatencyMeasurement[]>([]);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const sessionConfigRef = useRef<SessionConfig | null>(null);
  const confirmedRef = useRef(false);
  const hasGreetedRef = useRef(false);
  const sessionStartRef = useRef<number>(0);
  const speechStartedAtRef = useRef<number | null>(null);
  const speechStoppedAtRef = useRef<number | null>(null);
  const firstAudioDeltaRef = useRef(false);
  const sessionIdRef = useRef<string>(crypto.randomUUID());
  const sessionExportRef = useRef<SessionExport | null>(null);

  // Regression test: resolves when next tool call arrives
  const pendingTestRef = useRef<{
    resolve: (r: { name: string; args: Record<string, unknown> }) => void;
    reject: (e: Error) => void;
  } | null>(null);

  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  // ── Logging ────────────────────────────────────────────────────────────────

  const logEvent = useCallback((direction: EventDirection, type: string, payload: unknown) => {
    const ts = Date.now();
    const relMs = ts - (sessionStartRef.current || ts);
    const entry: LoggedEvent = {
      id: crypto.randomUUID(),
      direction,
      type,
      ts,
      relMs,
      payload,
    };
    setEventLog((prev) => [...prev, entry]);
    if (sessionExportRef.current) {
      sessionExportRef.current.events.push(entry);
    }
  }, []);

  const sendEvent = useCallback((event: object) => {
    const evType = (event as { type?: string }).type ?? "unknown";
    logEvent("out", evType, event);
    if (dcRef.current?.readyState === "open") {
      dcRef.current.send(JSON.stringify(event));
    }
  }, [logEvent]);

  const updateConnStats = useCallback(() => {
    const pc = pcRef.current;
    const dc = dcRef.current;
    setConnectionStats({
      ice: pc?.iceConnectionState ?? null,
      pc: pc?.connectionState ?? null,
      dc: dc?.readyState ?? null,
      signaling: pc?.signalingState ?? null,
    });
  }, []);

  // ── Event handler ──────────────────────────────────────────────────────────

  const handleEvent = useCallback((event: RealtimeEvent) => {
    logEvent("in", event.type, event);

    switch (event.type) {
      case "session.created":
        break;

      case "session.updated":
        setStatus("ready");
        if (!hasGreetedRef.current && modeRef.current !== "safe") {
          hasGreetedRef.current = true;
          sendEvent({ type: "response.create" });
        }
        break;

      case "input_audio_buffer.speech_started":
        speechStartedAtRef.current = Date.now();
        firstAudioDeltaRef.current = false;
        setStatus("listening");
        setUserTranscript("");
        break;

      case "input_audio_buffer.speech_stopped":
        speechStoppedAtRef.current = Date.now();
        setStatus("thinking");
        break;

      case "conversation.item.input_audio_transcription.completed": {
        const transcript = String(event.transcript ?? "");
        setUserTranscript(transcript);
        if (transcript.trim()) {
          setMessages((p) => [...p, { role: "user", text: transcript, ts: Date.now() }]);
        }
        if (speechStartedAtRef.current) {
          const ms = Date.now() - speechStartedAtRef.current;
          const measurement: LatencyMeasurement = { type: "stt", ms, ts: Date.now() };
          setLatencyLog((p) => [...p, measurement]);
          if (sessionExportRef.current) sessionExportRef.current.latency.push(measurement);
        }
        break;
      }

      case "response.audio_transcript.delta":
        if (!firstAudioDeltaRef.current) {
          firstAudioDeltaRef.current = true;
          if (speechStoppedAtRef.current) {
            const ms = Date.now() - speechStoppedAtRef.current;
            const measurement: LatencyMeasurement = { type: "response", ms, ts: Date.now() };
            setLatencyLog((p) => [...p, measurement]);
            if (sessionExportRef.current) sessionExportRef.current.latency.push(measurement);
          }
        }
        setStatus("speaking");
        setAiMessage((p) => p + String(event.delta ?? ""));
        break;

      case "response.audio_transcript.done": {
        const fullText = String(event.transcript ?? "");
        if (fullText.trim()) {
          setMessages((p) => [...p, { role: "assistant", text: fullText, ts: Date.now() }]);
        }
        setAiMessage(fullText);
        break;
      }

      case "response.done":
        if (!confirmedRef.current) setStatus("ready");
        break;

      case "response.function_call_arguments.done": {
        const callName = String(event.name ?? "");
        const callArgs = JSON.parse(String(event.arguments ?? "{}")) as Record<string, unknown>;
        setStatus("tool_calling");

        // Resolve pending regression test if waiting
        if (pendingTestRef.current) {
          pendingTestRef.current.resolve({ name: callName, args: callArgs });
          pendingTestRef.current = null;
        }

        // Echo tool output back (debug: just ack)
        sendEvent({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: String(event.call_id ?? ""),
            output: JSON.stringify({ debug_ack: true, tool: callName }),
          },
        });
        sendEvent({ type: "response.create" });
        break;
      }

      case "error": {
        const errObj = event.error as { code?: string; type?: string; message?: string } | undefined;
        const detail = [errObj?.type, errObj?.code, errObj?.message].filter(Boolean).join(" | ") || "voice_error";
        setErrorMessage(detail);
        setStatus("error");
        break;
      }
    }
  }, [logEvent, sendEvent]);

  // ── Connect ────────────────────────────────────────────────────────────────

  const cleanupRefs = useCallback(() => {
    if (dcRef.current) {
      dcRef.current.onclose = null;
      dcRef.current.close();
    }
    pcRef.current?.close();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    if (audioElRef.current) {
      audioElRef.current.srcObject = null;
      audioElRef.current.pause();
    }
    dcRef.current = null;
    pcRef.current = null;
    micStreamRef.current = null;
    audioElRef.current = null;
    if (sessionExportRef.current) sessionExportRef.current.endedAt = Date.now();
  }, []);

  const start = useCallback(async (shopSlug: string, language: "en" | "vi") => {
    if (status !== "idle" && status !== "ended" && status !== "error") return;

    // Reset session state
    sessionIdRef.current = crypto.randomUUID();
    sessionStartRef.current = Date.now();
    confirmedRef.current = false;
    hasGreetedRef.current = false;
    speechStartedAtRef.current = null;
    speechStoppedAtRef.current = null;
    firstAudioDeltaRef.current = false;
    sessionConfigRef.current = null;
    sessionExportRef.current = {
      id: sessionIdRef.current,
      mode: modeRef.current,
      salon: shopSlug,
      language,
      startedAt: sessionStartRef.current,
      endedAt: null,
      events: [],
      latency: [],
    };

    setStatus("connecting_mic");
    setErrorMessage(null);
    setMessages([]);
    setAiMessage("");
    setUserTranscript("");
    setConnectionStats({ ice: null, pc: null, dc: null, signaling: null });

    logEvent("system", "session.start", { mode: modeRef.current, shopSlug, language, model: REALTIME_CONFIG.model, voice: REALTIME_CONFIG.voice });

    try {
      if (!window.isSecureContext) throw Object.assign(new Error("insecure_context"), { name: "InsecureContext" });
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("no_media_devices"), { name: "NoMediaDevices" });

      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 24000 },
      });
      micStreamRef.current = micStream;
      logEvent("system", "mic.granted", { tracks: micStream.getAudioTracks().length });

      setStatus("connecting_openai");
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      pc.oniceconnectionstatechange = () => {
        logEvent("system", "ice.state", { state: pc.iceConnectionState });
        updateConnStats();
      };
      pc.onconnectionstatechange = () => {
        logEvent("system", "pc.state", { state: pc.connectionState });
        updateConnStats();
        if (pc.connectionState === "failed") {
          setErrorMessage("connection_failed");
          setStatus("error");
          cleanupRefs();
        }
      };
      pc.onsignalingstatechange = () => updateConnStats();

      const audioEl = new Audio();
      audioEl.autoplay = true;
      audioElRef.current = audioEl;
      pc.ontrack = (e) => {
        if (audioEl.srcObject !== e.streams[0]) audioEl.srcObject = e.streams[0] ?? null;
      };

      const [micTrack] = micStream.getAudioTracks();
      if (micTrack) pc.addTrack(micTrack, micStream);

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      updateConnStats();

      dc.onerror = (e) => logEvent("system", "dc.error", { error: String(e) });

      dc.onopen = () => {
        logEvent("system", "dc.open", {});
        updateConnStats();

        const cfg = sessionConfigRef.current;
        const tools = modeRef.current === "safe" ? [] : (cfg?.tools ?? []);
        const toolChoice = modeRef.current === "safe" ? "none" : "auto";
        const sessionUpdate = {
          type: "session.update",
          session: {
            modalities: ["audio", "text"],
            instructions: cfg?.instructions ?? "You are a helpful assistant.",
            voice: cfg?.voice ?? REALTIME_CONFIG.voice,
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            input_audio_transcription: { model: REALTIME_CONFIG.transcriptionModel },
            turn_detection: {
              type: "server_vad",
              threshold: REALTIME_CONFIG.vad.threshold,
              prefix_padding_ms: REALTIME_CONFIG.vad.prefixPaddingMs,
              silence_duration_ms: REALTIME_CONFIG.vad.silenceDurationMs,
            },
            tools,
            tool_choice: toolChoice,
            temperature: 0.7,
          },
        };
        sendEvent(sessionUpdate);
        setStatus("ready");
      };

      dc.onmessage = (e: MessageEvent) => {
        try { handleEvent(JSON.parse(e.data as string) as RealtimeEvent); } catch { /* ignore */ }
      };

      dc.onclose = () => {
        logEvent("system", "dc.closed", {
          ice: pcRef.current?.iceConnectionState,
          pc: pcRef.current?.connectionState,
        });
        updateConnStats();
        if (!confirmedRef.current) setStatus("ended");
      };

      setStatus("connecting_dc");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      logEvent("system", "sdp.offer", { bytes: offer.sdp?.length ?? 0 });

      const sdpRes = await fetch("/api/voice/sdp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salon_slug: shopSlug, language, sdp_offer: offer.sdp }),
      });

      if (!sdpRes.ok) {
        // Read raw text FIRST — never lose the body even if JSON parse fails
        const rawBody = await sdpRes.text();
        let parsedBody: Record<string, unknown> | null = null;
        try { parsedBody = JSON.parse(rawBody) as Record<string, unknown>; } catch { /* non-JSON body */ }
        const sdpErrPayload: Record<string, unknown> = {
          // HTTP layer
          http_status: sdpRes.status,
          http_status_text: sdpRes.statusText,
          // Full response body — raw (never truncated) + parsed if JSON
          raw_body: rawBody,
          parsed_body: parsedBody,
          // What OpenAI said (inside the proxy's JSON envelope)
          openai_status: parsedBody?.openai_status ?? null,
          openai_detail: parsedBody?.detail ?? null,
          openai_error_code: parsedBody?.error ?? null,
          model_used: parsedBody?.model_used ?? REALTIME_CONFIG.model,
          // Request context
          proxy_endpoint: "/api/voice/sdp",
          openai_endpoint: REALTIME_CONFIG.sdpEndpoint,
          model: REALTIME_CONFIG.model,
          voice: REALTIME_CONFIG.voice,
          request_salon: shopSlug,
          request_language: language,
          sdp_offer_bytes: offer.sdp?.length ?? 0,
        };
        logEvent("system", "sdp.error", sdpErrPayload);
        const errorCode = String(parsedBody?.error ?? "sdp_exchange_failed");
        const thrown = new Error(errorCode);
        (thrown as unknown as Record<string, unknown>)._sdpPayload = sdpErrPayload;
        throw thrown;
      }

      const { sdp_answer, session_config } = await sdpRes.json() as { sdp_answer: string; session_config: SessionConfig };
      logEvent("system", "sdp.answer", { bytes: sdp_answer.length });
      sessionConfigRef.current = session_config;

      await pc.setRemoteDescription({ type: "answer", sdp: sdp_answer });
      logEvent("system", "sdp.complete", {});

    } catch (err) {
      const serialized = serializeError(err);
      const errName = String(serialized.name ?? "");
      const errMsg = String(serialized.message ?? "unknown");
      // _sdpPayload is attached by the throw above — surface it at top level
      const sdpPayload = (err as Record<string, unknown>)._sdpPayload ?? null;
      const code =
        errName === "NotAllowedError" ? "mic_denied"
        : errName === "NotFoundError" ? "mic_not_found"
        : errName === "NotReadableError" ? "mic_in_use"
        : errMsg === "insecure_context" ? "insecure_context"
        : errMsg === "salon_not_found" ? "salon_not_found"
        : errMsg;
      logEvent("system", "connect.error", {
        code,
        // Full serialized error — never {}
        error: serialized,
        // SDP failure context promoted to top level for quick scanning
        sdp_http_status: (sdpPayload as Record<string, unknown> | null)?.http_status ?? null,
        sdp_raw_body: (sdpPayload as Record<string, unknown> | null)?.raw_body ?? null,
        sdp_openai_detail: (sdpPayload as Record<string, unknown> | null)?.openai_detail ?? null,
        sdp_model: (sdpPayload as Record<string, unknown> | null)?.model ?? null,
        sdp_payload: sdpPayload,
      });
      setErrorMessage(code);
      setStatus("error");
      cleanupRefs();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, handleEvent, sendEvent, logEvent, updateConnStats, cleanupRefs]);

  const end = useCallback(() => {
    logEvent("system", "session.end", {});
    cleanupRefs();
    setStatus("ended");
    updateConnStats();
  }, [cleanupRefs, logEvent, updateConnStats]);

  // ── Text injection ─────────────────────────────────────────────────────────

  const injectText = useCallback((text: string) => {
    if (!text.trim()) return;
    logEvent("system", "text.inject", { text });
    sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    sendEvent({ type: "response.create" });
  }, [logEvent, sendEvent]);

  // ── Regression runner ──────────────────────────────────────────────────────

  const runTest = useCallback(async (test: RegressionTest): Promise<RegressionResult> => {
    const t0 = Date.now();
    if (status !== "ready" && status !== "listening" && status !== "thinking") {
      return { test, passed: false, error: "not_connected", durationMs: 0 };
    }
    try {
      const toolCallPromise = new Promise<{ name: string; args: Record<string, unknown> }>((resolve, reject) => {
        pendingTestRef.current = { resolve, reject };
        setTimeout(() => {
          if (pendingTestRef.current) {
            pendingTestRef.current = null;
            reject(new Error("timeout"));
          }
        }, test.timeoutMs ?? 15000);
      });

      injectText(test.input);
      const result = await toolCallPromise;

      let passed = true;
      if (test.expectedToolName && result.name !== test.expectedToolName) passed = false;
      if (test.expectedArgsSubset) {
        for (const [k, v] of Object.entries(test.expectedArgsSubset)) {
          if (result.args[k] !== v) { passed = false; break; }
        }
      }

      return {
        test, passed,
        actualToolName: result.name,
        actualArgs: result.args,
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      return { test, passed: false, error: String(err), durationMs: Date.now() - t0 };
    }
  }, [status, injectText]);

  // ── Utilities ──────────────────────────────────────────────────────────────

  const clearLog = useCallback(() => setEventLog([]), []);

  const exportSession = useCallback((): string => {
    return JSON.stringify(sessionExportRef.current ?? {}, null, 2);
  }, []);

  useEffect(() => () => cleanupRefs(), [cleanupRefs]);

  return {
    status, mode, connectionStats, errorMessage,
    userTranscript, aiMessage, messages,
    eventLog, latencyLog,
    setMode, start, end,
    injectText, clearLog, exportSession, runTest,
  };
}
