"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtimeVoice, type VoiceCallStatus, type LatencySnapshot } from "@/hooks/useRealtimeVoice.legacy";
import type { BookingResult } from "@/shared/booking/submitPublicBooking";

type Props = {
  shopSlug: string;
  language: "en" | "vi";
  onBookingConfirmed?: (booking: BookingResult) => void;
};

// ─── Status helpers ───────────────────────────────────────────────────────────

function statusLabel(s: VoiceCallStatus, lang: "en" | "vi"): string {
  const vi = lang === "vi";
  const map: Record<VoiceCallStatus, string> = {
    idle:              vi ? "Đặt lịch bằng giọng nói"  : "Book with Voice AI",
    connecting_mic:    vi ? "Đang kết nối mic…"         : "Preparing microphone…",
    connecting_openai: vi ? "Đang kết nối AI…"          : "Connecting to AI…",
    connecting_dc:     vi ? "Đang khởi động phiên…"     : "Starting voice session…",
    ready:             vi ? "Đang nghe…"                : "Listening…",
    listening:         vi ? "Đang nghe…"                : "Listening…",
    thinking:          vi ? "Đang xử lý…"               : "Processing…",
    speaking:          vi ? "AI đang nói"               : "AI Speaking",
    tool_calling:      vi ? "Đang kiểm tra lịch…"       : "Checking availability…",
    confirmed:         vi ? "Đặt lịch thành công! ✓"    : "Booking Confirmed! ✓",
    ended:             vi ? "Cuộc gọi đã kết thúc"      : "Call Ended",
    error:             vi ? "Đã có lỗi"                 : "Error",
  };
  return map[s];
}

// ─── Animations ───────────────────────────────────────────────────────────────

function PulseRing({ color = "var(--salon-primary,#d4af37)" }: { color?: string }) {
  return (
    <span className="absolute inset-0 rounded-full animate-ping opacity-30"
      style={{ backgroundColor: color }} />
  );
}

function SpeakingBars() {
  const bars = [
    { h: 0.4, dur: 500 }, { h: 0.7, dur: 380 }, { h: 1.0, dur: 300 },
    { h: 0.85, dur: 360 }, { h: 0.55, dur: 440 }, { h: 0.35, dur: 520 },
  ];
  return (
    <>
      <style>{`
        @keyframes voiceBar {
          0%   { transform: scaleY(0.2); }
          100% { transform: scaleY(1); }
        }
      `}</style>
      <div className="flex items-center justify-center gap-[3px]" style={{ height: 28 }}>
        {bars.map((b, i) => (
          <span key={i} style={{
            display: "inline-block", width: 3,
            height: Math.round(28 * b.h),
            borderRadius: 2,
            background: "var(--salon-primary,#d4af37)",
            transformOrigin: "center",
            animation: `voiceBar ${b.dur}ms ease-in-out ${i * 60}ms infinite alternate`,
          }} />
        ))}
      </div>
    </>
  );
}

function ThinkingDots() {
  return (
    <>
      <style>{`
        @keyframes dot { 0%,80%,100% { opacity:.25;transform:translateY(0) } 40% { opacity:1;transform:translateY(-4px) } }
      `}</style>
      <div className="flex gap-1.5 items-center justify-center" style={{ height: 28 }}>
        {[0, 150, 300].map((d) => (
          <span key={d} style={{
            width: 7, height: 7, borderRadius: "50%",
            background: "var(--salon-primary,#d4af37)",
            display: "inline-block",
            animation: `dot 1s ease-in-out ${d}ms infinite`,
          }} />
        ))}
      </div>
    </>
  );
}

// ─── Message feed ──────────────────────────────────────────────────────────────

function MessageFeed({ messages, aiMessage, userTranscript, isStreaming }: {
  messages: { role: "user" | "assistant"; text: string; timestamp: number }[];
  aiMessage: string;
  userTranscript: string;
  isStreaming: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, aiMessage, userTranscript]);

  return (
    <div className="min-h-[80px] max-h-[200px] overflow-y-auto flex flex-col gap-2 px-1 text-[13px]">
      {messages.map((m, i) => (
        <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
          <div className={`rounded-2xl px-3 py-1.5 max-w-[85%] leading-snug ${
            m.role === "user"
              ? "bg-white/12 text-white/85"
              : "bg-[var(--salon-primary,#d4af37)]/15 text-white/90"
          }`}>
            {m.text}
          </div>
        </div>
      ))}
      {/* Live AI streaming bubble */}
      {isStreaming && aiMessage && (
        <div className="flex justify-start">
          <div className="rounded-2xl px-3 py-1.5 max-w-[85%] bg-[var(--salon-primary,#d4af37)]/10 text-white/65 leading-snug">
            {aiMessage}<span className="inline-block w-[2px] h-[13px] ml-0.5 align-text-bottom bg-[var(--salon-primary,#d4af37)]/60 animate-pulse" />
          </div>
        </div>
      )}
      {/* Live user transcript while speaking */}
      {userTranscript && (
        <div className="flex justify-end">
          <div className="rounded-2xl px-3 py-1.5 max-w-[85%] bg-white/8 text-white/45 italic leading-snug">
            {userTranscript}…
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

// ─── Latency badge ────────────────────────────────────────────────────────────

function LatencyBadge({ latency }: { latency: LatencySnapshot }) {
  const { responseMs, sttMs } = latency;
  if (responseMs === null) return null;

  const color = responseMs < 500 ? "text-green-400/70" : responseMs < 900 ? "text-amber-400/70" : "text-red-400/70";
  return (
    <div className={`flex items-center gap-1.5 text-[10px] font-mono ${color}`} title="response latency (speech end → first audio)">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-current opacity-70" />
      <span>~{responseMs}ms</span>
      {sttMs !== null && <span className="text-white/25">· STT {sttMs}ms</span>}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function RealtimeVoiceCall({ shopSlug, language, onBookingConfirmed }: Props) {
  const [isOpen, setIsOpen] = useState(false);

  const {
    status, userTranscript, aiMessage, messages,
    confirmedBooking, errorMessage, isMuted, latency,
    start, end, toggleMute,
  } = useRealtimeVoice({
    shopSlug,
    language,
    onConfirmed: onBookingConfirmed,
  });

  const isVi = language === "vi";
  const isConnecting = status === "connecting_mic" || status === "connecting_openai" || status === "connecting_dc";
  const isActive = status !== "idle" && status !== "ended" && status !== "error";
  const isError = status === "error";
  const isDone = status === "confirmed";
  const isMicDenied = isError && errorMessage === "mic_denied";
  const isMicNotFound = isError && errorMessage === "mic_not_found";
  const isMicInUse = isError && errorMessage === "mic_in_use";
  const isInsecure = isError && (errorMessage === "insecure_context" || errorMessage === "no_media_devices");

  const handleStart = useCallback(async () => {
    setIsOpen(true);
    await start();
  }, [start]);

  const handleEnd = useCallback(() => {
    end();
    if (isDone) {
      // Keep open on confirmed to show summary
      return;
    }
    setTimeout(() => setIsOpen(false), 400);
  }, [end, isDone]);

  // Auto-close after confirmed + 8s
  useEffect(() => {
    if (status !== "confirmed") return;
    const id = setTimeout(() => setIsOpen(false), 8_000);
    return () => clearTimeout(id);
  }, [status]);

  // Entry button (collapsed state)
  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={handleStart}
        className="group w-full flex items-center gap-3 rounded-2xl border border-[var(--salon-primary,#d4af37)]/25 bg-[var(--salon-primary,#d4af37)]/5 px-5 py-4 text-left transition-all hover:border-[var(--salon-primary,#d4af37)]/50 hover:bg-[var(--salon-primary,#d4af37)]/10"
      >
        <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
          style={{ background: "var(--salon-primary,#d4af37)" }}>
          <PhoneIcon className="h-5 w-5 text-black" />
        </span>
        <div>
          <p className="text-[14px] font-semibold text-white/90">
            {isVi ? "Gọi đặt lịch với AI" : "Book with AI Voice"}
          </p>
          <p className="text-[11px] text-white/45 mt-0.5">
            {isVi ? "Nói chuyện tự nhiên — AI xử lý tất cả" : "Just talk — AI handles everything"}
          </p>
        </div>
        <span className="ml-auto text-[11px] font-medium text-[var(--salon-primary,#d4af37)]/70 group-hover:text-[var(--salon-primary,#d4af37)]">
          {isVi ? "Gọi ngay →" : "Start →"}
        </span>
      </button>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-[var(--salon-primary,#d4af37)]/25 bg-black/50 backdrop-blur-md">
      {/* Gold gradient top line */}
      <div className="absolute left-0 right-0 top-0 h-px"
        style={{ background: "linear-gradient(90deg,transparent,var(--salon-primary,#d4af37) 50%,transparent)" }} />

      <div className="p-5 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            {/* Status dot */}
            <span className={`relative flex h-2.5 w-2.5 rounded-full ${
              isError ? "bg-red-500"
              : isDone ? "bg-green-400"
              : isActive ? "bg-[var(--salon-primary,#d4af37)]"
              : "bg-white/30"
            }`}>
              {isActive && !isDone && (
                <span className="absolute inset-0 animate-ping rounded-full opacity-50"
                  style={{ backgroundColor: "var(--salon-primary,#d4af37)" }} />
              )}
            </span>
            <span className="text-[12px] font-semibold uppercase tracking-wider text-white/60">
              {statusLabel(status, language)}
            </span>
          </div>

          {/* Latency badge + close */}
          <div className="flex items-center gap-3">
            <LatencyBadge latency={latency} />
            {!isDone && (
              <button type="button" onClick={handleEnd}
                className="text-[11px] text-white/30 hover:text-white/60 transition-colors">
                {isActive ? (isVi ? "Cúp máy" : "End") : "✕"}
              </button>
            )}
          </div>
        </div>

        {/* Central animation */}
        <div className="flex justify-center py-1">
          {isConnecting && (
            <div className="flex flex-col items-center gap-2">
              <div className="h-8 w-8 rounded-full border-2 border-t-transparent animate-spin"
                style={{ borderColor: "var(--salon-primary,#d4af37)", borderTopColor: "transparent" }} />
              <span className="text-[10px] text-white/40">
                {status === "connecting_mic"    ? (isVi ? "1/3 · Mic"         : "1/3 · Mic")         : null}
                {status === "connecting_openai" ? (isVi ? "2/3 · Kết nối AI"  : "2/3 · AI")          : null}
                {status === "connecting_dc"     ? (isVi ? "3/3 · Phiên voice" : "3/3 · Voice session"): null}
              </span>
            </div>
          )}
          {(status === "ready" || status === "listening") && (
            <div className="relative flex h-14 w-14 items-center justify-center rounded-full"
              style={{ background: "var(--salon-primary,#d4af37)22" }}>
              <PulseRing />
              <MicIcon className="h-6 w-6 text-[var(--salon-primary,#d4af37)]" />
            </div>
          )}
          {status === "speaking" && <SpeakingBars />}
          {(status === "thinking" || status === "tool_calling") && <ThinkingDots />}
          {isDone && (
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-green-500/20">
              <CheckIcon className="h-7 w-7 text-green-400" />
            </div>
          )}
          {isError && (
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-red-500/20">
              <span className="text-2xl">⚠</span>
            </div>
          )}
        </div>

        {/* Error: mic denied */}
        {isMicDenied && (
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/8 px-4 py-3 space-y-2">
            <p className="text-[13px] font-semibold text-amber-400 text-center">
              {isVi ? "Microphone bị chặn" : "Microphone Blocked"}
            </p>
            <p className="text-[11px] text-white/55 text-center leading-relaxed">
              {isVi
                ? "Vui lòng cho phép microphone trong cài đặt trình duyệt, sau đó thử lại."
                : "Please allow microphone access in your browser settings, then try again."}
            </p>
            <div className="text-[10px] text-white/35 space-y-0.5">
              <p>Chrome: {isVi ? "Bấm ổ khóa 🔒 trên thanh địa chỉ → Microphone → Allow" : "Click 🔒 in address bar → Microphone → Allow"}</p>
              <p>Safari: {isVi ? "Safari → Settings → Websites → Microphone → Allow" : "Safari → Settings → Websites → Microphone → Allow"}</p>
            </div>
          </div>
        )}

        {/* Error: mic not found */}
        {isMicNotFound && (
          <p className="text-center text-[12px] text-red-400/90">
            {isVi ? "Không tìm thấy microphone. Vui lòng kết nối microphone và thử lại." : "No microphone found. Please connect a microphone and try again."}
          </p>
        )}

        {/* Error: mic in use by another app */}
        {isMicInUse && (
          <p className="text-center text-[12px] text-red-400/90">
            {isVi ? "Microphone đang được dùng bởi ứng dụng khác. Vui lòng đóng và thử lại." : "Microphone is in use by another app. Close it and try again."}
          </p>
        )}

        {/* Error: insecure context / no mediaDevices */}
        {isInsecure && (
          <p className="text-center text-[12px] text-red-400/90">
            {isVi ? "Tính năng này yêu cầu kết nối HTTPS." : "Voice requires a secure (HTTPS) connection."}
          </p>
        )}

        {/* Error: other — show real error detail for debugging */}
        {isError && !isMicDenied && !isMicNotFound && !isMicInUse && !isInsecure && (
          <div className="text-center space-y-1">
            <p className="text-[12px] text-red-400/90">
              {isVi ? "Kết nối thất bại. Vui lòng thử lại." : "Connection failed. Please try again."}
            </p>
            {errorMessage && errorMessage !== "connection_failed" && (
              <p className="text-[10px] text-white/35 font-mono break-all px-2">
                {errorMessage}
              </p>
            )}
          </div>
        )}

        {/* Confirmed summary */}
        {isDone && confirmedBooking && (
          <div className="rounded-xl border border-green-500/25 bg-green-500/8 px-4 py-3 space-y-1 text-center">
            <p className="text-[13px] font-semibold text-green-400">
              {isVi ? "✓ Đặt lịch thành công!" : "✓ Booking Confirmed!"}
            </p>
            <p className="text-[11px] text-white/55">
              {new Date(confirmedBooking.startTimeUtc).toLocaleString(isVi ? "vi-VN" : "en-US", {
                weekday: "short", month: "short", day: "numeric",
                hour: "numeric", minute: "2-digit",
              })}
              {confirmedBooking.staffName ? ` · ${confirmedBooking.staffName}` : ""}
            </p>
          </div>
        )}

        {/* Conversation transcript */}
        {messages.length > 0 || aiMessage || userTranscript ? (
          <MessageFeed
            messages={messages}
            aiMessage={aiMessage}
            userTranscript={userTranscript}
            isStreaming={status === "speaking"}
          />
        ) : status === "ready" ? (
          <p className="text-center text-[12px] text-white/35 py-2">
            {isVi
              ? "Nói tên dịch vụ bạn muốn đặt…"
              : "Say the service you'd like to book…"}
          </p>
        ) : null}

        {/* Controls: mute / end */}
        {isActive && !isDone && (
          <div className="flex items-center justify-center gap-3 pt-1">
            <button
              type="button"
              onClick={toggleMute}
              className={`flex items-center gap-1.5 rounded-full border px-4 py-2 text-[12px] font-medium transition-all ${
                isMuted
                  ? "border-red-500/50 bg-red-500/15 text-red-400"
                  : "border-white/15 bg-white/6 text-white/60 hover:bg-white/10"
              }`}
            >
              {isMuted ? <MicOffIcon className="h-3.5 w-3.5" /> : <MicIcon className="h-3.5 w-3.5" />}
              {isMuted ? (isVi ? "Đã tắt mic" : "Muted") : (isVi ? "Đang nghe" : "Live")}
            </button>

            <button
              type="button"
              onClick={handleEnd}
              className="flex items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/15 px-4 py-2 text-[12px] font-medium text-red-400 hover:bg-red-500/25 transition-all"
            >
              <PhoneOffIcon className="h-3.5 w-3.5" />
              {isVi ? "Cúp máy" : "End Call"}
            </button>
          </div>
        )}

        {/* Retry + text fallback */}
        {isError && (
          <div className="space-y-2">
            {!isMicDenied && (
              <button type="button" onClick={handleStart}
                className="w-full rounded-full bg-[var(--salon-primary,#d4af37)]/15 py-2.5 text-[12px] font-semibold text-[var(--salon-primary,#d4af37)] hover:bg-[var(--salon-primary,#d4af37)]/25 transition-all">
                {isVi ? "Thử lại" : "Try Again"}
              </button>
            )}
            {isMicDenied && (
              <button type="button" onClick={handleStart}
                className="w-full rounded-full bg-[var(--salon-primary,#d4af37)]/15 py-2.5 text-[12px] font-semibold text-[var(--salon-primary,#d4af37)] hover:bg-[var(--salon-primary,#d4af37)]/25 transition-all">
                {isVi ? "Thử lại sau khi cho phép mic" : "Retry After Allowing Mic"}
              </button>
            )}
            <button type="button" onClick={() => { setIsOpen(false); }}
              className="w-full py-1.5 text-[11px] text-white/30 hover:text-white/50 transition-colors">
              {isVi ? "Dùng form đặt lịch thay thế ↓" : "Use text booking instead ↓"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function PhoneIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81a19.79 19.79 0 01-3.07-8.67A2 2 0 012 1h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.91 8.49a16 16 0 006.6 6.6l1.86-1.34a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
    </svg>
  );
}

function PhoneOffIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M10.68 13.31a16 16 0 003.41 2.6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07" />
      <path d="M6.2 4.72A19.79 19.79 0 012 2M1 1l22 22" />
    </svg>
  );
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 2a3 3 0 00-3 3v7a3 3 0 006 0V5a3 3 0 00-3-3z" />
      <path d="M19 10v2a7 7 0 01-14 0v-2M12 19v3" />
    </svg>
  );
}

function MicOffIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M1 1l22 22M9 9v3a3 3 0 005.12 2.12M15 9.34V5a3 3 0 00-5.94-.6" />
      <path d="M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23M12 19v3" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
      strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
