"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  submitPublicBooking,
  type BookingResult,
} from "@/shared/booking/submitPublicBooking";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";

// ─── Types ────────────────────────────────────────────────────────────────────

export type VoiceCallStatus =
  | "idle"
  | "connecting"
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

export type UseRealtimeVoiceReturn = {
  status: VoiceCallStatus;
  userTranscript: string;
  aiMessage: string;
  messages: ConversationMessage[];
  bookingProgress: BookingProgress;
  confirmedBooking: BookingResult | null;
  errorMessage: string | null;
  isMuted: boolean;
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

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micTrackRef = useRef<MediaStreamTrack | null>(null);
  const confirmedRef = useRef(false);
  const sessionConfigRef = useRef<SessionConfig | null>(null);
  const hasGreetedRef = useRef(false);

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
      switch (event.type) {
        case "session.created":
          // Session established — send config and trigger greeting
          break;

        case "session.updated":
          setStatus("ready");
          // Trigger initial greeting once after config is applied
          if (!hasGreetedRef.current) {
            hasGreetedRef.current = true;
            sendEvent({ type: "response.create" });
          }
          break;

        case "input_audio_buffer.speech_started":
          setStatus("listening");
          setUserTranscript("");
          break;

        case "input_audio_buffer.speech_stopped":
          setStatus("thinking");
          break;

        case "conversation.item.input_audio_transcription.completed": {
          const transcript = String(event.transcript ?? "");
          setUserTranscript(transcript);
          if (transcript.trim()) appendMessage("user", transcript);
          break;
        }

        case "response.audio_transcript.delta":
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
          if (status !== "confirmed" && status !== "ended" && status !== "error") {
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
          const errObj = event.error as { message?: string } | undefined;
          console.error("[voice] Realtime error:", errObj);
          setErrorMessage(errObj?.message ?? "Voice connection error");
          setStatus("error");
          break;
        }
      }
    },
    [status, handleToolCall, appendMessage, sendEvent],
  );

  // ── Connect (GA flow: server-proxied SDP exchange) ───────────────────────────
  const start = useCallback(async () => {
    if (status !== "idle" && status !== "ended" && status !== "error") return;

    confirmedRef.current = false;
    hasGreetedRef.current = false;
    sessionConfigRef.current = null;
    setStatus("connecting");
    setErrorMessage(null);
    setMessages([]);
    setBookingProgress({});
    setConfirmedBooking(null);
    setAiMessage("");
    setUserTranscript("");

    try {
      // 1. Microphone
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 24000 },
      });
      micStreamRef.current = micStream;
      const [micTrack] = micStream.getAudioTracks();
      if (micTrack) micTrackRef.current = micTrack;

      // 2. Peer connection
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

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

      dc.onmessage = (e: MessageEvent) => {
        try {
          handleEvent(JSON.parse(e.data as string) as RealtimeEvent);
        } catch { /* ignore malformed */ }
      };

      dc.onopen = () => {
        // Push session config (instructions, voice, tools) via data channel
        const cfg = sessionConfigRef.current;
        if (cfg) {
          sendEvent({
            type: "session.update",
            session: {
              modalities: ["audio", "text"],
              instructions: cfg.instructions,
              voice: cfg.voice,
              input_audio_format: "pcm16",
              output_audio_format: "pcm16",
              input_audio_transcription: { model: "gpt-realtime-whisper" },
              turn_detection: {
                type: "server_vad",
                threshold: 0.45,
                prefix_padding_ms: 200,
                silence_duration_ms: 700,
              },
              tools: cfg.tools,
              tool_choice: "auto",
              temperature: 0.7,
            },
          });
        }
        setStatus("ready");
      };

      dc.onclose = () => {
        if (!confirmedRef.current) setStatus("ended");
      };

      // 6. Create SDP offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // 7. Server-proxied SDP exchange with OpenAI GA Realtime API
      const sdpRes = await fetch("/api/voice/sdp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          salon_slug: shopSlugRef.current,
          language,
          sdp_offer: offer.sdp,
        }),
      });

      if (!sdpRes.ok) {
        const err = await sdpRes.json().catch(() => ({})) as { error?: string; detail?: string };
        console.error("[voice] SDP exchange failed:", err);
        throw new Error(err.error ?? "sdp_exchange_failed");
      }

      const { sdp_answer, session_config } = (await sdpRes.json()) as {
        sdp_answer: string;
        session_config: SessionConfig;
      };

      // Store config for dc.onopen (may fire shortly after setRemoteDescription)
      sessionConfigRef.current = session_config;

      await pc.setRemoteDescription({ type: "answer", sdp: sdp_answer });

      // Connection established — dc.onopen fires when ICE completes
    } catch (err) {
      console.error("[voice] connect error:", err);
      const msg = err instanceof Error ? err.message : "unknown";
      setErrorMessage(
        msg.includes("Permission") || msg.includes("NotAllowed")
          ? "Microphone access denied."
          : msg === "salon_not_found"
          ? "Salon not found."
          : "Connection failed. Please try again.",
      );
      setStatus("error");
      cleanupRefs();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, language, handleEvent, sendEvent]);

  // ── Disconnect ───────────────────────────────────────────────────────────────
  const cleanupRefs = useCallback(() => {
    dcRef.current?.close();
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
    start, end, toggleMute,
  };
}
