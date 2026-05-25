"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceParseResult } from "@/app/api/booking/voice-parse/route";
import type { VoiceChatMessage, VoiceChatResponse } from "@/app/api/booking/voice-chat/route";
import type { BookingMessages } from "@/shared/i18n/booking/en";

type ServiceItem = { id: string; name: string };
type StaffItem = { id: string; name: string };

type Props = {
  t: BookingMessages;
  services: readonly ServiceItem[];
  staff: readonly StaffItem[];
  language?: "en" | "vi";
  onFill: (result: VoiceParseResult) => void;
  onDone?: (result: VoiceParseResult) => void;
};

type ChatStep = "service" | "date" | "time" | "name" | "phone" | null;

type State =
  | { kind: "idle" }
  | { kind: "chat_speaking"; aiText: string }
  | { kind: "chat_listening"; aiText: string; transcript: string }
  | { kind: "chat_processing"; aiText: string }
  | { kind: "text_input"; text: string }
  | { kind: "done"; result: VoiceParseResult }
  | { kind: "error"; message: string; allowTextFallback?: boolean };

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionResultList {
  length: number;
  [index: number]: { isFinal: boolean; 0: { transcript: string } };
}
interface SpeechRecognitionInstance extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

function getSpeechRecognitionClass(): (new () => SpeechRecognitionInstance) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  const SR =
    (w["SpeechRecognition"] as (new () => SpeechRecognitionInstance) | undefined) ??
    (w["webkitSpeechRecognition"] as (new () => SpeechRecognitionInstance) | undefined);
  return SR ?? null;
}

const EN_VOICE_PRIORITY = [
  "Google US English",
  "Samantha",
  "Karen",
  "Google UK English Female",
  "Microsoft Aria Online (Natural)",
];

function getBestVoice(lang: "en" | "vi"): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  if (lang === "vi") return voices.find((v) => v.lang.startsWith("vi")) ?? null;
  for (const name of EN_VOICE_PRIORITY) {
    const match = voices.find((v) => v.name === name);
    if (match) return match;
  }
  return voices.find((v) => v.lang === "en-US") ?? voices.find((v) => v.lang.startsWith("en")) ?? null;
}

function determineStep(filled: Partial<VoiceParseResult>): ChatStep {
  if (!filled.serviceId && !filled.serviceName) return "service";
  if (!filled.dateHint) return "date";
  if (!filled.timeHint) return "time";
  if (!filled.clientName) return "name";
  if (!filled.clientPhone) return "phone";
  return null;
}

function getNextPrompt(step: Exclude<ChatStep, null>, justSelected: string, lang: "en" | "vi"): string {
  if (step === "service") {
    return lang === "vi"
      ? `Bạn muốn đặt dịch vụ gì ạ?`
      : `Which service would you like to book?`;
  }
  if (step === "date") {
    return lang === "vi"
      ? `${justSelected} — lựa chọn tuyệt vời! Bạn muốn đặt vào ngày nào ạ?`
      : `${justSelected} — lovely choice! What day works for you?`;
  }
  if (step === "time") {
    return lang === "vi"
      ? `Được rồi! Bạn muốn đến lúc mấy giờ ạ?`
      : `Perfect! And what time would you like?`;
  }
  if (step === "name") {
    return lang === "vi"
      ? `Cho em hỏi tên của bạn là gì ạ?`
      : `Great! May I have your name please?`;
  }
  return lang === "vi"
    ? `Và số điện thoại của bạn ạ?`
    : `And your phone number please?`;
}

function getDoneMessage(filled: Partial<VoiceParseResult>, lang: "en" | "vi"): string {
  const service = filled.serviceName ?? "";
  const date = filled.dateHint ?? "";
  const time = filled.timeHint ?? "";
  return lang === "vi"
    ? `Tuyệt vời! Em đã đặt ${service} vào ${date} lúc ${time} cho bạn rồi ạ. Đang xác nhận lịch hẹn…`
    : `You're all set! I've got your ${service} booked for ${date} at ${time}. Confirming your booking now!`;
}

const QUICK_DATES_EN = ["Today", "Tomorrow", "This Saturday", "This Sunday"];
const QUICK_DATES_VI = ["Hôm nay", "Ngày mai", "Thứ Bảy này", "Chủ Nhật này"];
const QUICK_TIMES = ["9:00 AM", "10:00 AM", "11:00 AM", "12:00 PM", "1:00 PM", "2:00 PM", "3:00 PM", "4:00 PM", "5:00 PM"];

// Bell-curve shaped waveform bars
const WAVE_BARS = [
  { amp: 0.30, dur: 560, delay: 0 },
  { amp: 0.55, dur: 440, delay: 80 },
  { amp: 0.80, dur: 360, delay: 40 },
  { amp: 1.00, dur: 310, delay: 0 },
  { amp: 0.80, dur: 380, delay: 60 },
  { amp: 0.55, dur: 460, delay: 100 },
  { amp: 0.30, dur: 540, delay: 20 },
] as const;

const BAR_MAX_H = 32;

function WaveformBars() {
  return (
    <>
      <style>{`
        @keyframes nqWaveBar { 0% { transform: scaleY(0.15); } 100% { transform: scaleY(1); } }
        @keyframes nqDotBounce { 0%, 80%, 100% { transform: translateY(0); opacity: 0.35; } 40% { transform: translateY(-5px); opacity: 1; } }
      `}</style>
      <div className="flex items-center justify-center gap-[3px]" style={{ height: `${BAR_MAX_H}px` }} aria-hidden>
        {WAVE_BARS.map((bar, i) => (
          <span key={i} style={{
            display: "inline-block", width: "3px",
            height: `${Math.round(BAR_MAX_H * bar.amp)}px`, borderRadius: "2px",
            background: "var(--salon-primary, #d4af37)", transformOrigin: "center",
            animation: `nqWaveBar ${bar.dur}ms ease-in-out ${bar.delay}ms infinite alternate`,
            opacity: 0.85,
          }} />
        ))}
      </div>
    </>
  );
}

function SpeakingDots() {
  return (
    <div className="flex items-center justify-center gap-1.5" style={{ height: `${BAR_MAX_H}px` }} aria-hidden>
      {[0, 160, 320].map((delay) => (
        <span key={delay} style={{
          display: "inline-block", width: "7px", height: "7px", borderRadius: "50%",
          background: "var(--salon-primary, #d4af37)",
          animation: `nqDotBounce 1s ease-in-out ${delay}ms infinite`,
        }} />
      ))}
    </div>
  );
}

function ResultBadge({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px]">
      <span className="text-white/50">{label}:</span>
      <span className="font-medium text-white">{value}</span>
    </span>
  );
}

function QuickChip({ label, onClick, style = "default" }: { label: string; onClick: () => void; style?: "default" | "brand" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        style === "brand"
          ? "rounded-full border border-[var(--salon-primary,#d4af37)]/35 bg-[var(--salon-primary,#d4af37)]/8 px-3 py-1.5 text-[11px] font-medium text-white/80 hover:bg-[var(--salon-primary,#d4af37)]/20 hover:text-white transition-all"
          : "rounded-full border border-white/15 bg-white/6 px-3 py-1.5 text-[11px] font-medium text-white/70 hover:bg-white/12 hover:text-white transition-all"
      }
    >
      {label}
    </button>
  );
}

export function VoiceBookingButton({ t, services, staff, language = "en", onFill, onDone }: Props) {
  const [speechSupported, setSpeechSupported] = useState<boolean | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [chatStep, setChatStep] = useState<ChatStep>(null);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const transcriptRef = useRef("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatActiveRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  // Exposed to chip tap handler (set inside startChat closure)
  const advanceWithChipRef = useRef<((type: ChatStep, label: string, id?: string) => void) | null>(null);

  useEffect(() => { setSpeechSupported(getSpeechRecognitionClass() !== null); }, []);

  useEffect(() => {
    if (state.kind === "text_input") window.setTimeout(() => textareaRef.current?.focus(), 80);
  }, [state.kind]);

  useEffect(() => {
    if (state.kind !== "done") return;
    const id = window.setTimeout(() => setState({ kind: "idle" }), 5_000);
    return () => window.clearTimeout(id);
  }, [state.kind]);

  useEffect(() => {
    return () => {
      chatActiveRef.current = false;
      sourceNodeRef.current?.stop();
      audioCtxRef.current?.close();
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    };
  }, []);

  const cancelChat = useCallback(() => {
    chatActiveRef.current = false;
    recognitionRef.current?.stop();
    sourceNodeRef.current?.stop();
    sourceNodeRef.current = null;
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    setChatStep(null);
    setState({ kind: "idle" });
  }, []);

  const startChat = useCallback(() => {
    // Create AudioContext in user gesture — required for iOS/Chrome autoplay policy
    if (typeof window !== "undefined") {
      try {
        const w = window as unknown as Record<string, unknown>;
        const ACtx = (w["AudioContext"] ?? w["webkitAudioContext"]) as (new () => AudioContext) | undefined;
        if (ACtx) { const ctx = new ACtx(); void ctx.resume(); audioCtxRef.current = ctx; }
      } catch { /* ignore */ }
    }

    chatActiveRef.current = true;
    transcriptRef.current = "";
    const filledState: Partial<VoiceParseResult> = {};
    const chatMessages: VoiceChatMessage[] = [];

    const greeting = t.voice.chatGreeting;
    chatMessages.push({ role: "assistant", content: greeting });
    setChatStep("service"); // always start by asking for service

    // --- Core playback ---
    async function playSpeech(text: string): Promise<void> {
      const ctx = audioCtxRef.current;
      if (ctx) {
        try {
          const res = await fetch("/api/booking/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, language }),
          });
          if (!res.ok) throw new Error("tts_unavailable");
          const arrayBuffer = await res.arrayBuffer();
          if (!chatActiveRef.current) return;
          if (ctx.state === "suspended") await ctx.resume();
          const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
          if (!chatActiveRef.current) return;
          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(ctx.destination);
          sourceNodeRef.current = source;
          await new Promise<void>((resolve) => {
            source.onended = () => { sourceNodeRef.current = null; resolve(); };
            source.start(0);
          });
          return;
        } catch { /* fall through */ }
      }
      if (typeof window === "undefined" || !window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      await new Promise<void>((resolve) => {
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = language === "vi" ? "vi-VN" : "en-US";
        const voice = getBestVoice(language);
        if (voice) utter.voice = voice;
        utter.onend = () => resolve();
        utter.onerror = () => resolve();
        window.speechSynthesis.speak(utter);
      });
    }

    // --- Conversation loop ---
    async function speakThenListen(text: string, msgHistory: VoiceChatMessage[]) {
      if (!chatActiveRef.current) return;
      setState({ kind: "chat_speaking", aiText: text });
      await playSpeech(text);
      if (chatActiveRef.current) window.setTimeout(() => startChatListening(text, msgHistory), 200);
    }

    function startChatListening(aiText: string, msgHistory: VoiceChatMessage[]) {
      if (!chatActiveRef.current) return;
      const SR = getSpeechRecognitionClass();
      if (!SR) { setState({ kind: "text_input", text: "" }); return; }

      const rec = new SR();
      rec.lang = language === "vi" ? "vi-VN" : "en-US";
      rec.interimResults = true;
      rec.continuous = false;
      transcriptRef.current = "";
      recognitionRef.current = rec;
      let errorHandled = false;

      rec.onresult = (e) => {
        if (!chatActiveRef.current) return;
        let full = "";
        for (let i = 0; i < e.results.length; i++) full += e.results[i]?.[0]?.transcript ?? "";
        transcriptRef.current = full;
        setState({ kind: "chat_listening", aiText, transcript: full });
      };

      rec.onerror = (e) => {
        if (!chatActiveRef.current) return;
        errorHandled = true;
        if (e.error === "not-allowed") {
          setState({ kind: "error", message: t.voice.micPermissionDenied, allowTextFallback: true });
        } else if (e.error === "no-speech") {
          // No speech — re-listen silently (chips still visible, user can tap)
          window.setTimeout(() => startChatListening(aiText, msgHistory), 400);
        } else {
          window.setTimeout(() => startChatListening(aiText, msgHistory), 600);
        }
      };

      rec.onend = () => {
        if (!chatActiveRef.current || errorHandled) return;
        const transcript = transcriptRef.current.trim();
        if (!transcript) {
          window.setTimeout(() => startChatListening(aiText, msgHistory), 400);
          return;
        }
        void sendMessage(transcript, aiText, msgHistory);
      };

      try {
        rec.start();
        setState({ kind: "chat_listening", aiText, transcript: "" });
      } catch {
        setState({ kind: "text_input", text: "" });
      }
    }

    async function sendMessage(userText: string, prevAiText: string, prevMessages: VoiceChatMessage[]) {
      if (!chatActiveRef.current) return;
      const newHistory: VoiceChatMessage[] = [...prevMessages, { role: "user", content: userText }];
      setState({ kind: "chat_processing", aiText: prevAiText });

      try {
        const res = await fetch("/api/booking/voice-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: newHistory,
            services: services.map((s) => ({ id: s.id, name: s.name })),
            staff: staff.map((s) => ({ id: s.id, name: s.name })),
            language,
          }),
        });
        if (!res.ok) throw new Error("api_failed");
        if (!chatActiveRef.current) return;

        const result = (await res.json()) as VoiceChatResponse;
        if (!chatActiveRef.current) return;

        const updatedHistory: VoiceChatMessage[] = [...newHistory, { role: "assistant", content: result.reply }];

        if (result.fill) {
          for (const [k, v] of Object.entries(result.fill)) {
            if (v !== null) (filledState as Record<string, unknown>)[k] = v;
          }
          if (Object.keys(filledState).length > 0) onFill(filledState as VoiceParseResult);
        }

        const step = determineStep(filledState);
        setChatStep(step);

        if (result.done) {
          chatActiveRef.current = false;
          const doneResult = filledState as VoiceParseResult;
          setState({ kind: "done", result: doneResult });
          onDone?.(doneResult);
          void playSpeech(result.reply);
        } else {
          void speakThenListen(result.reply, updatedHistory);
        }
      } catch {
        if (!chatActiveRef.current) return;
        const errMsg = language === "vi" ? "Xin lỗi, thử lại nhé?" : "Sorry, could you say that again?";
        void speakThenListen(errMsg, prevMessages);
      }
    }

    // Chip tap: skip API, advance directly with known data
    advanceWithChipRef.current = function advanceWithChip(
      type: ChatStep,
      label: string,
      id?: string,
    ) {
      if (!chatActiveRef.current || !type) return;

      if (type === "service" && id) {
        filledState.serviceId = id;
        filledState.serviceName = label;
      } else if (type === "date") {
        filledState.dateHint = label;
      } else if (type === "time") {
        filledState.timeHint = label;
      }
      onFill(filledState as VoiceParseResult);

      const step = determineStep(filledState);
      setChatStep(step);

      if (step === null) {
        chatActiveRef.current = false;
        const doneResult = filledState as VoiceParseResult;
        setState({ kind: "done", result: doneResult });
        onDone?.(doneResult);
        void playSpeech(getDoneMessage(filledState, language));
        return;
      }

      const nextPrompt = getNextPrompt(step, label, language);
      const newMsgs: VoiceChatMessage[] = [
        ...chatMessages,
        { role: "user", content: label },
        { role: "assistant", content: nextPrompt },
      ];
      // Keep chatMessages in sync
      chatMessages.push({ role: "user", content: label }, { role: "assistant", content: nextPrompt });
      void speakThenListen(nextPrompt, newMsgs);
    };

    void speakThenListen(greeting, chatMessages);
  }, [language, services, staff, onFill, onDone, t.voice.chatGreeting, t.voice.micPermissionDenied]);

  const submitText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setState({ kind: "chat_processing", aiText: "" });
      void (async () => {
        try {
          const res = await fetch("/api/booking/voice-parse", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              transcript: trimmed,
              services: services.map((s) => ({ id: s.id, name: s.name })),
              staff: staff.map((s) => ({ id: s.id, name: s.name })),
            }),
          });
          if (!res.ok) throw new Error();
          const result = (await res.json()) as VoiceParseResult;
          const hasMatch = result.serviceId ?? result.staffId ?? result.dateHint ?? result.timeHint;
          if (hasMatch) { onFill(result); setState({ kind: "done", result }); }
          else setState({ kind: "error", message: t.voice.noMatch, allowTextFallback: true });
        } catch {
          setState({ kind: "error", message: t.voice.parseError, allowTextFallback: true });
        }
      })();
    },
    [services, staff, onFill, t.voice],
  );

  const reset = useCallback(() => { cancelChat(); setState({ kind: "idle" }); }, [cancelChat]);

  if (speechSupported === null) return null;
  if (!speechSupported && state.kind === "idle") {
    return (
      <TextInput t={t} text="" textareaRef={textareaRef}
        onTextChange={(text) => setState({ kind: "text_input", text })}
        onSubmit={submitText} onReset={reset} />
    );
  }

  const isChatPhase =
    state.kind === "chat_speaking" ||
    state.kind === "chat_listening" ||
    state.kind === "chat_processing";

  const quickDates = language === "vi" ? QUICK_DATES_VI : QUICK_DATES_EN;

  return (
    <div className="flex flex-col items-center gap-3">
      {/* Idle mic button */}
      {state.kind === "idle" && speechSupported && (
        <button
          type="button"
          onClick={startChat}
          className="group relative flex items-center gap-2.5 rounded-full border border-[var(--salon-primary,#d4af37)]/25 bg-[var(--salon-primary,#d4af37)]/5 px-5 py-2.5 text-[13px] font-medium text-white/70 transition-all duration-200 hover:border-[var(--salon-primary,#d4af37)]/55 hover:bg-[var(--salon-primary,#d4af37)]/10 hover:text-white/95"
        >
          <MicIcon className="h-4 w-4 text-[var(--salon-primary,#d4af37)] opacity-70 transition-opacity group-hover:opacity-100" />
          {t.voice.tapToSpeak}
        </button>
      )}

      {/* Conversational chat card */}
      {isChatPhase && (
        <div className="relative w-full overflow-hidden rounded-2xl border border-[var(--salon-primary,#d4af37)]/20 bg-black/40 p-5 backdrop-blur-sm space-y-3">
          {/* Gold gradient top line */}
          <div className="absolute left-0 right-0 top-0 h-[1px]"
            style={{ background: "linear-gradient(90deg, transparent, var(--salon-primary, #d4af37) 50%, transparent)" }} />

          {/* AI message bubble */}
          <div className="rounded-xl bg-white/6 px-3.5 py-2.5">
            <p className="text-[13px] leading-snug text-white/85">
              {state.aiText || t.voice.chatGreeting}
            </p>
          </div>

          {/* Phase indicator */}
          <div className="flex flex-col items-center gap-2">
            {state.kind === "chat_speaking" && (
              <>
                <SpeakingDots />
                <span className="text-[10px] font-medium uppercase tracking-widest text-white/35">
                  {t.voice.chatSpeaking}
                </span>
              </>
            )}
            {state.kind === "chat_listening" && (
              <>
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
                      style={{ backgroundColor: "var(--salon-primary, #d4af37)" }} />
                    <span className="relative inline-flex h-2 w-2 rounded-full"
                      style={{ backgroundColor: "var(--salon-primary, #d4af37)" }} />
                  </span>
                  <span className="text-[11px] font-semibold uppercase tracking-[0.1em]"
                    style={{ color: "color-mix(in srgb, var(--salon-primary, #d4af37) 80%, white)" }}>
                    {t.voice.listening}
                  </span>
                </div>
                <WaveformBars />
                {state.transcript ? (
                  <p className="text-[12px] italic text-white/60 text-center leading-snug">{state.transcript}</p>
                ) : (
                  <p className="text-[12px] text-white/25 text-center">{t.voice.speakNow}</p>
                )}
              </>
            )}
            {state.kind === "chat_processing" && (
              <div className="flex items-center gap-2 py-2">
                <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-t-transparent"
                  style={{ borderColor: "var(--salon-primary, #d4af37)", borderTopColor: "transparent" }} />
                <span className="text-[12px] text-white/45">{t.voice.processing}</span>
              </div>
            )}
          </div>

          {/* Quick-select chips — shown during speaking + listening, hidden during processing */}
          {state.kind !== "chat_processing" && (
            <>
              {chatStep === "service" && services.length > 0 && (
                <div className="flex flex-wrap gap-1.5 justify-center pt-1">
                  {services.slice(0, 8).map((s) => (
                    <QuickChip key={s.id} label={s.name} style="brand"
                      onClick={() => advanceWithChipRef.current?.("service", s.name, s.id)} />
                  ))}
                </div>
              )}
              {chatStep === "date" && (
                <div className="flex flex-wrap gap-1.5 justify-center pt-1">
                  {quickDates.map((d) => (
                    <QuickChip key={d} label={d}
                      onClick={() => advanceWithChipRef.current?.("date", d)} />
                  ))}
                </div>
              )}
              {chatStep === "time" && (
                <div className="flex flex-wrap gap-1.5 justify-center pt-1">
                  {QUICK_TIMES.map((t) => (
                    <QuickChip key={t} label={t}
                      onClick={() => advanceWithChipRef.current?.("time", t)} />
                  ))}
                </div>
              )}
            </>
          )}

          {/* Cancel */}
          <div className="flex justify-center pt-1">
            <button type="button" onClick={cancelChat}
              className="text-[11px] text-white/30 hover:text-white/60 transition-colors">
              {t.voice.chatCancel}
            </button>
          </div>
        </div>
      )}

      {/* Text input fallback */}
      {state.kind === "text_input" && (
        <TextInput t={t} text={state.text} textareaRef={textareaRef}
          onTextChange={(text) => setState({ kind: "text_input", text })}
          onSubmit={submitText} onReset={reset} />
      )}

      {/* Done */}
      {state.kind === "done" && (
        <div className="w-full rounded-2xl border border-green-500/25 bg-green-500/8 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-green-400/80">{t.voice.matched}</p>
            <button type="button" onClick={reset} className="text-[10px] text-white/30 hover:text-white/60">✕</button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {state.result.serviceName && <ResultBadge label={t.summaryService} value={state.result.serviceName} />}
            {state.result.staffName && <ResultBadge label={t.summaryStaff} value={state.result.staffName} />}
            {state.result.dateHint && <ResultBadge label={t.summaryTime} value={state.result.dateHint} />}
            {state.result.timeHint && <ResultBadge label="⏰" value={state.result.timeHint} />}
          </div>
        </div>
      )}

      {/* Error */}
      {state.kind === "error" && (
        <div className="w-full rounded-xl border border-red-500/20 bg-red-500/8 px-3 py-3 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[11px] leading-snug text-red-400/90">{state.message}</p>
            <button type="button" onClick={reset} className="text-[10px] text-white/30 hover:text-white/60 shrink-0">✕</button>
          </div>
          {state.allowTextFallback && (
            <button type="button" onClick={() => setState({ kind: "text_input", text: "" })}
              className="text-[11px] text-[var(--salon-primary,#d4af37)]/80 hover:text-[var(--salon-primary,#d4af37)] underline underline-offset-2">
              {t.voice.textInputHint.split(".")[0]} →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TextInput({ t, text, textareaRef, onTextChange, onSubmit, onReset }: {
  t: BookingMessages; text: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onTextChange: (v: string) => void; onSubmit: (v: string) => void; onReset: () => void;
}) {
  return (
    <div className="w-full rounded-2xl border border-white/15 bg-black/25 p-4 space-y-3">
      <p className="text-[11px] text-white/50 text-center leading-snug">{t.voice.textInputHint}</p>
      <textarea ref={textareaRef} rows={2} placeholder={t.voice.textInputPlaceholder}
        className="w-full resize-none rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-sm text-white placeholder:text-white/25 focus:border-[var(--salon-primary,#d4af37)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--salon-primary,#d4af37)]/30"
        value={text} onChange={(e) => onTextChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(text); } }} />
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={onReset} className="text-[11px] text-white/30 hover:text-white/60">{t.back}</button>
        <button type="button" onClick={() => onSubmit(text)} disabled={!text.trim()}
          className="rounded-full bg-[var(--salon-primary,#d4af37)] px-4 py-1.5 text-[12px] font-semibold text-black disabled:opacity-40 transition-opacity">
          {t.voice.textSubmit}
        </button>
      </div>
    </div>
  );
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden>
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}
