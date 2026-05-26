"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  submitPublicBooking,
  type BookingResult,
} from "@/shared/booking/submitPublicBooking";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { REALTIME_MODEL, REALTIME_VOICE, REALTIME_TRANSCRIPTION_MODEL, REALTIME_VAD } from "@/config/realtime";

// ─── Types ────────────────────────────────────────────────────────────────────

export type VoiceCallStatus =
  | "idle"
  | "connecting_mic"      // acquiring microphone permission
  | "connecting_openai"   // SDP exchange with OpenAI
  | "connecting_dc"       // waiting for data channel / ICE
  | "ready"
  | "listening"
  | "thinking"
  | "speaking"
  | "tool_calling"
  | "confirmed"
  | "ended"
  | "error";

export type ConversationMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
};

export type BookingProgress = {
  serviceId?: string;
  serviceName?: string;
  date?: string;
  timeSlot?: string;
  staffId?: string;
  staffName?: string;
  customerName?: string;
  customerPhone?: string;
};

export type LatencySnapshot = {
  responseMs: number | null;   // speech_stopped → first audio delta
  sttMs: number | null;        // speech_started → transcription completed
};

export type UseRealtimeVoiceReturn = {
  status: VoiceCallStatus;
  userTranscript: string;
  aiMessage: string;
  messages: ConversationMessage[];
  bookingProgress: BookingProgress;
  confirmedBooking: BookingResult | null;
  errorMessage: string | null;
  isMuted: boolean;
  latency: LatencySnapshot;
  start: () => Promise<void>;
  end: () => void;
  toggleMute: () => void;
};

type RealtimeEvent = {
  type: string;
  [key: string]: unknown;
};

type SessionConfig = {
  instructions: string;
  voice: string;
  tools: unknown[];
};

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useRealtimeVoice(params: {
  shopSlug: string;
  language: "en" | "vi";
  onConfirmed?: (booking: BookingResult) => void;
}): UseRealtimeVoiceReturn {
  const { shopSlug, language, onConfirmed } = params;

  const [status, setStatus] = useState<VoiceCallStatus>("idle");
  const [userTranscript, setUserTranscript] = useState("");
  const [aiMessage, setAiMessage] = useState("");
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [bookingProgress, setBookingProgress] = useState<BookingProgress>({});
  const [confirmedBooking, setConfirmedBooking] = useState<BookingResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [latency, setLatency] = useState<LatencySnapshot>({ responseMs: null, sttMs: null });

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micTrackRef = useRef<MediaStreamTrack | null>(null);
  const confirmedRef = useRef(false);
  const sessionConfigRef = useRef<SessionConfig | null>(null);
  const hasGreetedRef = useRef(false);
  const speechStartedAtRef = useRef<number | null>(null);
  const speechStoppedAtRef = useRef<number | null>(null);
  const firstAudioDeltaRef = useRef(false);

  const shopSlugRef = useRef(shopSlug);
  useEffect(() => { shopSlugRef.current = shopSlug; }, [shopSlug]);

  const sendEvent = useCallback((event: object) => {
    if (dcRef.current?.readyState === "open") {
      dcRef.current.send(JSON.stringify(event));
    }
  }, []);

  const appendMessage = useCallback((role: "user" | "assistant", text: string) => {
    setMessages((prev) => [...prev, { role, text, timestamp: Date.now() }]);
  }, []);

  // ── Tool execution ──────────────────────────────────────────────────────────
  const handleToolCall = useCallback(
    async (callId: string, name: string, argsRaw: string) => {
      setStatus("tool_calling");
      let output: unknown;

      try {
        const args = JSON.parse(argsRaw) as Record<string, unknown>;

        if (name === "get_available_slots") {
          const { service_id, date, staff_id } = args as {
            service_id: string;
            date: string;
            staff_id?: string;
          };
          const res = await fetch("/api/voice/slots", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              salon_slug: shopSlugRef.current,
              service_id,
              date,
              staff_id,
            }),
          });
          output = res.ok ? await res.json() : { error: "slots_fetch_failed" };
        }

        else if (name === "confirm_booking") {
          const {
            service_id, date, time_slot, staff_id,
            customer_name, customer_phone,
          } = args as {
            service_id: string;
            date: string;
            time_slot: string;
            staff_id: string;
            customer_name: string;
            customer_phone: string;
          };

          try {
            const result = await submitPublicBooking({
              shopSlug: shopSlugRef.current,
              serviceId: service_id,
              timeSlot: time_slot,
              bookingDateYmd: date,
              staffId: staff_id === "any" ? BOOKING_ANY_STAFF_ID : staff_id,
              clientName: customer_name,
              clientPhone: customer_phone,
              verificationMethod: "none",
            });

            confirmedRef.current = true;
            setConfirmedBooking(result);
            setStatus("confirmed");
            setBookingProgress((prev) => ({
              ...prev,
              customerName: customer_name,
              customerPhone: customer_phone,
              date,
              timeSlot: time_slot,
              staffId: staff_id === "any" ? undefined : staff_id,
            }));
            onConfirmed?.(result);

            output = {
              success: true,
              booking_id: result.bookingId,
              message: "Booking confirmed. Tell the customer their appointment is set.",
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : "booking_failed";
            output = { success: false, error: msg, message: "Booking failed. Tell customer and offer retry." };
          }
        }

        else {
          output = { error: "unknown_tool" };
        }
      } catch {
        output = { error: "tool_execution_failed" };
      }

      sendEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(output),
        },
      });
      sendEvent({ type: "response.create" });
    },
    [sendEvent, onConfirmed],
  );

  // ── Main event dispatcher ────────────────────────────────────────────────────
  const handleEvent = useCallback(
    (event: RealtimeEvent) => {
      // Log every event for full observability — filter by [voice-event] in DevTools
      console.debug("[voice-event]", event.type, event);

      switch (event.type) {
        case "session.created":
          console.info("[voice-connect] session_created");
          break;

        case "session.updated":
          console.info("[voice-connect] session_updated — AI ready, greeting triggered");
          setStatus("ready");
          // Trigger initial greeting once after config is applied
          if (!hasGreetedRef.current) {
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
          if (transcript.trim()) appendMessage("user", transcript);
          if (speechStartedAtRef.current) {
            setLatency((prev) => ({ ...prev, sttMs: Date.now() - speechStartedAtRef.current! }));
          }
          break;
        }

        case "response.audio_transcript.delta":
          if (!firstAudioDeltaRef.current) {
            firstAudioDeltaRef.current = true;
            if (speechStoppedAtRef.current) {
              setLatency((prev) => ({ ...prev, responseMs: Date.now() - speechStoppedAtRef.current! }));
            }
          }
          setStatus("speaking");
          setAiMessage((prev) => prev + String(event.delta ?? ""));
          break;

        case "response.audio_transcript.done": {
          const fullText = String(event.transcript ?? "");
          if (fullText.trim()) appendMessage("assistant", fullText);
          setAiMessage(fullText);
          break;
        }

        case "response.done":
          // Use confirmedRef (not status from closure) to avoid stale-closure false resets
          if (!confirmedRef.current) {
            setStatus("ready");
          }
          break;

        case "response.cancelled":
          break;

        case "response.function_call_arguments.done":
          void handleToolCall(
            String(event.call_id ?? ""),
            String(event.name ?? ""),
            String(event.arguments ?? "{}"),
          );
          break;

        case "error": {
          const errObj = event.error as { code?: string; type?: string; message?: string } | undefined;
          console.error("[voice-error] realtime_error", errObj);
          // Surface the real OpenAI error — includes model/tool/schema rejection details
          const detail = [errObj?.type, errObj?.code, errObj?.message].filter(Boolean).join(" | ") || "voice_error";
          setErrorMessage(detail);
          setStatus("error");
          break;
        }
      }
    },
    [handleToolCall, appendMessage, sendEvent],
  );

  // ── Connect (GA flow: server-proxied SDP exchange) ───────────────────────────
  const start = useCallback(async () => {
    if (status !== "idle" && status !== "ended" && status !== "error") return;

    confirmedRef.current = false;
    hasGreetedRef.current = false;
    sessionConfigRef.current = null;
    speechStartedAtRef.current = null;
    speechStoppedAtRef.current = null;
    firstAudioDeltaRef.current = false;
    setStatus("connecting_mic");
    setErrorMessage(null);
    setMessages([]);
    setBookingProgress({});
    setConfirmedBooking(null);
    setAiMessage("");
    setUserTranscript("");
    setLatency({ responseMs: null, sttMs: null });

    try {
      // 1. Pre-flight checks (before touching any API)
      if (!window.isSecureContext) {
        throw Object.assign(new Error("insecure_context"), { name: "InsecureContext" });
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        throw Object.assign(new Error("no_media_devices"), { name: "NoMediaDevices" });
      }

      console.info("[voice-connect] click_start", {
        salon: shopSlugRef.current,
        lang: language,
        safeMode: false,
        ua: navigator.userAgent.slice(0, 80),
      });

      // Phase 1: Microphone
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 24000 },
      });
      micStreamRef.current = micStream;
      const [micTrack] = micStream.getAudioTracks();
      if (micTrack) micTrackRef.current = micTrack;
      console.info("[voice-connect] mic_granted", { tracks: micStream.getAudioTracks().length });

      // Phase 2a: Get ephemeral key from server
      setStatus("connecting_openai");
      console.info("[voice-connect] fetching_ephemeral_key", { salon: shopSlugRef.current, language });
      const sessionRes = await fetch("/api/voice/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salon_slug: shopSlugRef.current, language }),
      });
      if (!sessionRes.ok) {
        const errBody = await sessionRes.json().catch(() => ({})) as { error?: string };
        console.error("[voice-error] session_create_failed", { status: sessionRes.status, error: errBody.error });
        throw new Error(errBody.error ?? "session_create_failed");
      }
      const { ephemeral_key, session_config: sessionCfg } = await sessionRes.json() as {
        ephemeral_key: string;
        session_config: SessionConfig;
      };
      console.info("[voice-connect] ephemeral_key_received", { key_prefix: ephemeral_key.slice(0, 8) + "…" });
      sessionConfigRef.current = sessionCfg;

      // Phase 2b: WebRTC peer connection
      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      console.info("[voice-connect] peer_created");

      // ICE / connection state watchers — critical for diagnosing transport failures
      pc.oniceconnectionstatechange = () => {
        console.info("[voice-connect] ice_state →", pc.iceConnectionState);
      };
      pc.onconnectionstatechange = () => {
        console.info("[voice-connect] pc_state →", pc.connectionState);
        if (pc.connectionState === "failed") {
          console.error("[voice-error] peer_connection_failed");
          setErrorMessage("connection_failed");
          setStatus("error");
          cleanupRefs();
        }
      };

      // 3. AI audio output → <audio> element
      const audioEl = new Audio();
      audioEl.autoplay = true;
      audioElRef.current = audioEl;
      pc.ontrack = (e) => {
        if (audioEl.srcObject !== e.streams[0]) {
          audioEl.srcObject = e.streams[0] ?? null;
        }
      };

      // 4. Add mic track
      if (micTrack) pc.addTrack(micTrack, micStream);

      // 5. Data channel for Realtime events
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      console.info("[voice-connect] data_channel_created");

      dc.onmessage = (e: MessageEvent) => {
        try {
          handleEvent(JSON.parse(e.data as string) as RealtimeEvent);
        } catch { /* ignore malformed */ }
      };

      dc.onerror = (e) => {
        console.error("[voice-error] data_channel_error", e);
      };

      dc.onopen = () => {
        console.info("[voice-connect] data_channel_open");
        const cfg = sessionConfigRef.current;
        if (cfg) {
          // Safe mode: send empty tools to isolate connection from tool schema issues
          const tools = false ? [] : cfg.tools;
          const toolChoice = false ? "none" : "auto";
          console.info("[voice-connect] session_update_sent", {
            voice: cfg.voice,
            toolCount: tools.length,
            safeMode: false,
            transcriptionModel: REALTIME_TRANSCRIPTION_MODEL,
          });
          sendEvent({
            type: "session.update",
            session: {
              modalities: ["audio", "text"],
              instructions: cfg.instructions,
              voice: cfg.voice,
              input_audio_format: "pcm16",
              output_audio_format: "pcm16",
              input_audio_transcription: { model: REALTIME_TRANSCRIPTION_MODEL },
              turn_detection: {
                type: "server_vad",
                threshold: REALTIME_VAD.threshold,
                prefix_padding_ms: REALTIME_VAD.prefixPaddingMs,
                silence_duration_ms: REALTIME_VAD.silenceDurationMs,
              },
              tools,
              tool_choice: toolChoice,
              temperature: 0.7,
            },
          });
        } else {
          console.warn("[voice-connect] dc opened but session config missing — session.update skipped");
        }
        setStatus("ready");
      };

      dc.onclose = () => {
        console.info("[voice-connect] data_channel_closed", {
          iceState: pcRef.current?.iceConnectionState,
          pcState: pcRef.current?.connectionState,
        });
        if (!confirmedRef.current) setStatus("ended");
      };

      // Phase 3: ICE + data channel
      setStatus("connecting_dc");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.info("[voice-connect] sdp_offer_created", { bytes: offer.sdp?.length ?? 0 });

      // Phase 3b: SDP exchange via server proxy — browser CORS blocks direct
      // application/sdp fetch to api.openai.com; server forwards using ephemeral key.
      console.info("[voice-connect] sdp_exchange_start", { proxy: "/api/voice/sdp", model: REALTIME_MODEL });
      const sdpRes = await fetch("/api/voice/sdp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ephemeral_key, sdp_offer: offer.sdp }),
      });

      if (!sdpRes.ok) {
        const rawBody = await sdpRes.text();
        let parsedErr: Record<string, unknown> = {};
        try { parsedErr = JSON.parse(rawBody) as Record<string, unknown>; } catch { /* non-JSON */ }
        console.error("[voice-error] sdp_exchange_failed", {
          status: sdpRes.status,
          error: parsedErr.error,
          openai_status: parsedErr.openai_status,
          openai_body: parsedErr.openai_body,
        });
        throw new Error(String(parsedErr?.error ?? "sdp_exchange_failed"));
      }

      const { sdp_answer } = await sdpRes.json() as { sdp_answer: string };
      console.info("[voice-connect] sdp_answer_received", { bytes: sdp_answer.length });

      await pc.setRemoteDescription({ type: "answer", sdp: sdp_answer });
      console.info("[voice-connect] remote_desc_set — waiting for ICE + data channel");

      // Connection established — dc.onopen fires when ICE completes
    } catch (err) {
      const errName = err instanceof DOMException ? err.name : (err instanceof Error ? (err as { name?: string }).name ?? "" : "");
      const errMsg = err instanceof Error ? err.message : "unknown";
      console.error("[voice] connect error", { name: errName, message: errMsg });

      // Use short error codes — UI maps these to human-readable text + instructions
      const code =
        errName === "NotAllowedError" || errName === "PermissionDeniedError"
          ? "mic_denied"
          : errName === "NotFoundError" || errName === "DevicesNotFoundError"
          ? "mic_not_found"
          : errName === "NotReadableError" || errName === "TrackStartError"
          ? "mic_in_use"
          : errName === "InsecureContext" || errMsg === "insecure_context"
          ? "insecure_context"
          : errName === "NoMediaDevices" || errMsg === "no_media_devices"
          ? "no_media_devices"
          : errMsg === "salon_not_found"
          ? "salon_not_found"
          : "connection_failed";

      setErrorMessage(code);
      setStatus("error");
      cleanupRefs();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, language, handleEvent, sendEvent]);

  // ── Disconnect ───────────────────────────────────────────────────────────────
  const cleanupRefs = useCallback(() => {
    if (dcRef.current) {
      dcRef.current.onclose = null; // prevent onclose from overwriting error/ended status
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
    micTrackRef.current = null;
    audioElRef.current = null;
  }, []);

  const end = useCallback(() => {
    cleanupRefs();
    setStatus("ended");
    setUserTranscript("");
  }, [cleanupRefs]);

  const toggleMute = useCallback(() => {
    const track = micTrackRef.current;
    if (!track) return;
    track.enabled = !track.enabled;
    setIsMuted(!track.enabled);
  }, []);

  useEffect(() => () => cleanupRefs(), [cleanupRefs]);

  return {
    status, userTranscript, aiMessage, messages,
    bookingProgress, confirmedBooking, errorMessage, isMuted,
    latency,
    start, end, toggleMute,
  };
}
