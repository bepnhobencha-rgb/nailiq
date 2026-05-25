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
  userTranscript: string;        // live in-progress user speech
  aiMessage: string;             // current/last AI message text
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

  // Stable ref so closures always see latest shopSlug
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
            service_id,
            date,
            time_slot,
            staff_id,
            customer_name,
            customer_phone,
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

      // Return result to OpenAI
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
        case "session.updated":
          setStatus("ready");
          break;

        case "input_audio_buffer.speech_started":
          // User started talking — interruption
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
          // Interrupted — stay in ready/listening
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
    [status, handleToolCall, appendMessage],
  );

  // ── Connect ──────────────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    if (status !== "idle" && status !== "ended" && status !== "error") return;

    confirmedRef.current = false;
    setStatus("connecting");
    setErrorMessage(null);
    setMessages([]);
    setBookingProgress({});
    setConfirmedBooking(null);
    setAiMessage("");
    setUserTranscript("");

    try {
      // 1. Ephemeral key from server
      const sessionRes = await fetch("/api/voice/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salon_slug: shopSlugRef.current, language }),
      });
      if (!sessionRes.ok) throw new Error("session_failed");
      const { client_secret } = (await sessionRes.json()) as {
        client_secret: { value: string };
      };

      // 2. Microphone
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 24000 },
      });
      micStreamRef.current = micStream;
      const [micTrack] = micStream.getAudioTracks();
      if (micTrack) micTrackRef.current = micTrack;

      // 3. Peer connection
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // 4. AI audio output → <audio> element
      const audioEl = new Audio();
      audioEl.autoplay = true;
      audioElRef.current = audioEl;
      pc.ontrack = (e) => {
        if (audioEl.srcObject !== e.streams[0]) {
          audioEl.srcObject = e.streams[0] ?? null;
        }
      };

      // 5. Add mic track
      if (micTrack) pc.addTrack(micTrack, micStream);

      // 6. Data channel for Realtime events
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.onmessage = (e: MessageEvent) => {
        try {
          handleEvent(JSON.parse(e.data as string) as RealtimeEvent);
        } catch { /* ignore malformed */ }
      };
      dc.onopen = () => setStatus("ready");
      dc.onclose = () => {
        if (!confirmedRef.current) setStatus("ended");
      };

      // 7. SDP offer → OpenAI Realtime endpoint
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpRes = await fetch(
        "https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${client_secret.value}`,
            "Content-Type": "application/sdp",
          },
          body: offer.sdp,
        },
      );

      if (!sdpRes.ok) throw new Error("webrtc_connect_failed");
      const answerSdp = await sdpRes.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      // Connection established — setStatus("ready") fires from dc.onopen
    } catch (err) {
      console.error("[voice] connect error:", err);
      setErrorMessage(
        err instanceof Error && err.message === "session_failed"
          ? "Could not start voice session."
          : err instanceof Error && err.message.includes("Permission")
          ? "Microphone access denied."
          : "Connection failed. Please try again.",
      );
      setStatus("error");
      cleanupRefs();
    }
  }, [status, language, handleEvent]);

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

  // Cleanup on unmount
  useEffect(() => () => cleanupRefs(), [cleanupRefs]);

  return {
    status,
    userTranscript,
    aiMessage,
    messages,
    bookingProgress,
    confirmedBooking,
    errorMessage,
    isMuted,
    start,
    end,
    toggleMute,
  };
}
