"use client";

// ManagerBriefingChat — guided onboarding wizard in chat form.
// When existingSip is provided (auto-learned from salon data), Minh opens with
// what it already knows and only asks 2 focused questions instead of 7.

import { useState, useRef, useEffect, useTransition } from "react";
import { Send, Loader2, RotateCcw } from "lucide-react";
import { runManagerBriefing } from "@/shared/ai/managerBriefingAction";
import { SipReviewCard } from "@/components/ai/SipReviewCard";
import type { SalonIntelligenceProfile } from "@/shared/ai/types";

type Message = {
  role: "user" | "assistant";
  content: string;
};

const GREETING_COLD =
  "Xin chào! Mình là Minh — AI Manager của NailIQ 👋\n\nMình sẽ hỏi bạn vài câu ngắn để hiểu tiệm — sau đó tự cấu hình để hỗ trợ nhắc lịch, giữ khách, và xử lý no-show đúng cách.\n\nBắt đầu nhé: Tiệm bạn làm dịch vụ gì? Ở đâu? Và có bao nhiêu nhân viên?";

function buildSmartGreeting(sip: SalonIntelligenceProfile, salonName: string): string {
  const voiceLabel: Record<string, string> = {
    warm_casual: "thân mật, gần gũi",
    warm_professional: "ấm áp, chuyên nghiệp",
    luxury_formal: "sang trọng, lịch sự",
    friendly_fun: "vui vẻ, thân thiện",
  };
  const strictnessLabel: Record<string, string> = {
    lenient: "nhẹ nhàng", moderate: "vừa phải", strict: "nghiêm ngặt",
  };
  return `Xin chào! Mình là Minh 👋\n\nMình đã tự tìm hiểu tiệm ${salonName} từ dữ liệu thực và đã tự cấu hình:\n• Loại tiệm: ${sip.vertical}\n• Chính sách no-show: ${strictnessLabel[sip.noshow_strictness] ?? sip.noshow_strictness}\n• Giọng điệu: ${voiceLabel[sip.brand_voice] ?? sip.brand_voice}\n• Liên lạc khách: ${sip.contact_window}\n\nChỉ còn 2 điều Minh chưa thể đoán từ data — trả lời xong là hoàn tất!\n\n**Câu 1:** Minh đoán tiệm bạn dùng giọng "${voiceLabel[sip.brand_voice] ?? sip.brand_voice}" khi nhắn tin cho khách. Đúng không? Nếu muốn điều chỉnh, cho Minh xem ví dụ câu bạn hay nhắn nhé.`;
}

type Props = {
  slug: string;
  salonName: string;
  existingSip?: SalonIntelligenceProfile | null;
  alreadyConfigured: boolean;
};

export function ManagerBriefingChat({ slug, salonName, existingSip, alreadyConfigured }: Props) {
  const initialGreeting = existingSip
    ? buildSmartGreeting(existingSip, salonName)
    : GREETING_COLD;

  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", content: initialGreeting },
  ]);
  const [input, setInput] = useState("");
  const [isPending, startTransition] = useTransition();
  const [sipDraft, setSipDraft] = useState<SalonIntelligenceProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to newest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sipDraft]);

  function handleReset() {
    setMessages([{ role: "assistant", content: initialGreeting }]);
    setSipDraft(null);
    setInput("");
    setError(null);
  }

  function handleSend() {
    const text = input.trim();
    if (!text || isPending || sipDraft) return;

    setError(null);
    const updated: Message[] = [...messages, { role: "user" as const, content: text }];
    setMessages(updated);
    setInput("");

    startTransition(async () => {
      const result = await runManagerBriefing({
        slug,
        messages: updated,
        existingSip: existingSip ?? undefined,
        salonName,
      });
      if (!result.ok) {
        setError("Có lỗi xảy ra — vui lòng thử lại.");
        return;
      }
      if (result.reply) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant" as const, content: result.reply },
        ]);
      }
      if (result.isComplete && result.sipDraft) {
        setSipDraft(result.sipDraft);
      }
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between pb-3 pt-1">
        <div>
          <p className="text-sm font-semibold text-nq-foreground">Manager Briefing</p>
          <p className="text-xs text-nq-muted">
            {existingSip
              ? "Minh đã tự học — xác nhận 2 điều là xong"
              : alreadyConfigured
                ? "Cập nhật cấu hình AI Manager"
                : "Cấu hình AI Manager lần đầu"}
          </p>
        </div>
        <button
          onClick={handleReset}
          className="flex items-center gap-1 rounded-lg border border-nq-border/40 px-2 py-1 text-xs text-nq-muted transition hover:border-nq-primary/30 hover:text-nq-primary"
          title="Bắt đầu lại"
        >
          <RotateCcw className="h-3 w-3" />
          Bắt đầu lại
        </button>
      </div>

      {/* Message list */}
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto pb-2">
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                msg.role === "user"
                  ? "rounded-br-sm bg-nq-primary text-white"
                  : "rounded-bl-sm border border-nq-border/35 bg-nq-surface/60 text-nq-foreground"
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}

        {/* Typing indicator while waiting */}
        {isPending && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-nq-border/35 bg-nq-surface/60 px-4 py-2.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-nq-primary" />
              <span className="text-xs text-nq-muted">Đang trả lời…</span>
            </div>
          </div>
        )}

        {/* SIP review card — shown after all 7 questions */}
        {sipDraft && !isPending && (
          <SipReviewCard slug={slug} initial={sipDraft} />
        )}

        {/* Error banner */}
        {error && (
          <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {error}
          </p>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input area — hidden once SIP draft is shown */}
      {!sipDraft && (
        <div className="mt-2 flex items-end gap-2 rounded-2xl border border-nq-border/40 bg-nq-surface/50 px-3 py-2">
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isPending}
            placeholder="Nhập câu trả lời của bạn…"
            className="flex-1 resize-none bg-transparent text-sm text-nq-foreground placeholder:text-nq-muted/60 focus:outline-none disabled:opacity-50"
            style={{ maxHeight: "120px" }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isPending}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-nq-primary text-white transition hover:opacity-90 disabled:opacity-40"
            aria-label="Gửi"
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </div>
      )}
    </div>
  );
}
