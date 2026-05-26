"use client";

import { useCallback, useRef, useState } from "react";
import { REALTIME_MODEL, REALTIME_VOICE, REALTIME_TRANSCRIPTION_MODEL, REALTIME_VAD } from "./realtime.constants";

console.log("REALTIME MODEL (frontend):", REALTIME_MODEL);

export type MinimalStatus =
  | "idle" | "mic" | "connecting" | "connected" | "error" | "ended";

export type LogEntry = {
  id: string;
  ts: number;
  relMs: number;
  event: string;
  detail?: unknown;
};

export type UseRealtimeMinimalReturn = {
  status: MinimalStatus;
  log: LogEntry[];
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
};

export function useRealtimeMinimal(): UseRealtimeMinimalReturn {
  const [status, setStatus]   = useState<MinimalStatus>("idle");
  const [log, setLog]         = useState<LogEntry[]>([]);
  const [error, setError]     = useState<string | null>(null);

  const pcRef       = useRef<RTCPeerConnection | null>(null);
  const dcRef       = useRef<RTCDataChannel | null>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const audioRef    = useRef<HTMLAudioElement | null>(null);
  const startTsRef  = useRef<number>(0);
  const statusRef   = useRef<MinimalStatus>("idle");

  const addLog = useCallback((event: string, detail?: unknown) => {
    const ts    = Date.now();
    const relMs = ts - (startTsRef.current || ts);
    const entry: LogEntry = { id: crypto.randomUUID(), ts, relMs, event, detail };
    setLog((prev) => [...prev, entry]);
    console.info(`[realtime-v2] +${relMs}ms ${event}`, detail ?? "");
  }, []);

  const cleanup = useCallback(() => {
    try { dcRef.current?.close(); } catch { /* ignore */ }
    try { pcRef.current?.close(); } catch { /* ignore */ }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (audioRef.current) {
      audioRef.current.srcObject = null;
      audioRef.current.pause();
    }
    dcRef.current  = null;
    pcRef.current  = null;
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    if (statusRef.current !== "idle" && statusRef.current !== "error" && statusRef.current !== "ended") return;

    startTsRef.current = Date.now();
    statusRef.current = "mic";
    setStatus("mic");
    setError(null);
    setLog([]);

    try {
      // ── 1. session.start ─────────────────────────────────────────────────
      addLog("session.start", { model: REALTIME_MODEL, voice: REALTIME_VOICE });

      if (!window.isSecureContext) throw Object.assign(new Error("insecure_context"), { name: "InsecureContext" });
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("no_media_devices"), { name: "NoMediaDevices" });

      // ── 2. getUserMedia ──────────────────────────────────────────────────
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 24000 },
      });
      streamRef.current = stream;
      addLog("mic.granted", { tracks: stream.getAudioTracks().length });

      statusRef.current = "connecting";
      setStatus("connecting");

      // ── 3. RTCPeerConnection ─────────────────────────────────────────────
      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      addLog("peer.created");

      pc.oniceconnectionstatechange = () => {
        addLog("ice.state", { state: pc.iceConnectionState });
      };
      pc.onconnectionstatechange = () => {
        addLog("pc.state", { state: pc.connectionState });
        if (pc.connectionState === "failed") {
          addLog("connect.error", { code: "pc_connection_failed" });
          setError("pc_connection_failed");
          statusRef.current = "error";
          setStatus("error");
          cleanup();
        }
      };
      pc.onsignalingstatechange = () => {
        addLog("signaling.state", { state: pc.signalingState });
      };

      // Remote audio output
      const audioEl = new Audio();
      audioEl.autoplay = true;
      audioRef.current = audioEl;
      pc.ontrack = (e) => {
        if (audioEl.srcObject !== e.streams[0]) audioEl.srcObject = e.streams[0] ?? null;
        addLog("track.received", { kind: e.track.kind });
      };

      // Mic track
      const [micTrack] = stream.getAudioTracks();
      if (micTrack) pc.addTrack(micTrack, stream);

      // Data channel
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onerror = (e) => addLog("dc.error", { error: String(e) });

      dc.onclose = () => {
        addLog("dc.closed", {});
        if (statusRef.current !== "error") {
          statusRef.current = "ended";
          setStatus("ended");
        }
      };

      dc.onmessage = (e: MessageEvent) => {
        try {
          const ev = JSON.parse(e.data as string) as { type: string };
          addLog(`rx.${ev.type}`, ev);
        } catch { /* ignore malformed */ }
      };

      dc.onopen = () => {
        addLog("data_channel_open", {});
        addLog("realtime.connected", { model: REALTIME_MODEL });
        statusRef.current = "connected";
        setStatus("connected");

        // Minimal session.update — no tools, no instructions, just audio config
        const update = {
          type: "session.update",
          session: {
            modalities: ["audio", "text"],
            voice: REALTIME_VOICE,
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            input_audio_transcription: { model: REALTIME_TRANSCRIPTION_MODEL },
            turn_detection: {
              type: "server_vad",
              threshold:             REALTIME_VAD.threshold,
              prefix_padding_ms:     REALTIME_VAD.prefixPaddingMs,
              silence_duration_ms:   REALTIME_VAD.silenceDurationMs,
            },
          },
        };
        addLog("session.update.sent", update);
        dc.send(JSON.stringify(update));
      };

      // ── 4. createOffer ───────────────────────────────────────────────────
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      addLog("sdp.offer", { bytes: offer.sdp?.length ?? 0 });

      // ── 5. SDP exchange via server proxy ─────────────────────────────────
      addLog("sdp.exchange", {
        proxy: "/api/realtime/sdp",
        model: REALTIME_MODEL,
        sdp_bytes: offer.sdp?.length ?? 0,
      });

      const sdpRes = await fetch("/api/realtime/sdp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp_offer: offer.sdp }),
      });

      if (!sdpRes.ok) {
        const rawBody = await sdpRes.text();
        let parsed: Record<string, unknown> | null = null;
        try { parsed = JSON.parse(rawBody) as Record<string, unknown>; } catch { /* non-JSON */ }

        const sdpErrorPayload = {
          // proxy response
          proxy_http_status:  sdpRes.status,
          proxy_http_text:    sdpRes.statusText,
          proxy_endpoint:     "/api/realtime/sdp",
          proxy_raw_body:     rawBody,
          // openai fields forwarded by proxy
          openai_status:      parsed?.openai_status  ?? null,
          openai_body:        parsed?.openai_body    ?? null,
          openai_headers:     parsed?.openai_headers ?? null,
          openai_model:       parsed?.model          ?? REALTIME_MODEL,
          openai_url:         parsed?.url            ?? null,
          // request context
          sdp_offer_bytes:    offer.sdp?.length ?? 0,
          model:              REALTIME_MODEL,
        };

        console.error("[RealtimeV2][SDP_ERROR]", sdpErrorPayload);
        addLog("sdp.error", sdpErrorPayload);
        throw new Error(`sdp_exchange_failed:${sdpRes.status}`);
      }

      const { sdp_answer } = await sdpRes.json() as { sdp_answer: string };
      addLog("sdp.answer", { bytes: sdp_answer.length });

      // ── 6. setRemoteDescription ──────────────────────────────────────────
      await pc.setRemoteDescription({ type: "answer", sdp: sdp_answer });
      addLog("remote_desc_set", {});

    } catch (err) {
      const name  = err instanceof Error ? err.name  : "";
      const msg   = err instanceof Error ? err.message : String(err);
      const code  =
        name === "NotAllowedError"  ? "mic_denied"
        : name === "NotFoundError"  ? "mic_not_found"
        : name === "NotReadableError" ? "mic_in_use"
        : msg === "insecure_context" ? "insecure_context"
        : msg;
      addLog("connect.error", { code, name, message: msg });
      setError(code);
      statusRef.current = "error";
      setStatus("error");
      cleanup();
    }
  }, [addLog, cleanup]);

  const stop = useCallback(() => {
    addLog("session.end", {});
    cleanup();
    statusRef.current = "ended";
    setStatus("ended");
  }, [addLog, cleanup]);

  return { status, log, error, start, stop };
}
