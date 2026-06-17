"use client";

// ManagerBriefingChat — guided onboarding wizard in chat form.
// The AI (Claude Sonnet) asks 7 questions about the salon, then generates a SIP draft.
// When complete, SipReviewCard renders the review/edit/confirm flow.

import { useState, useRef, useEffect, useTransition } from "react";
import { Send, Loader2, RotateCcw } from "lucide-react";
import { runManagerBriefing } from "@/shared/ai/managerBriefingAction";
import { SipReviewCard } from "@/components/ai/SipReviewCard";
import type { SalonIntelligenceProfile } from "@/shared/ai/types";

type Message = {
  role: "user" | "assistant";
  content: string;
};

const GREETING =
  "Xin chào! Mình là AI Manager của NailIQ 👋\n\nMình sẽ hỏi bạn 7 câu ngắn để hiểu tiệm của bạn — sau đó tự cấu hình để hỗ trợ việc nhắc lịch, giữ khách, và xử lý no-show đúng cách.\n\nBắt đầu nhé: Tiệm bạn làm dịch vụ gì? Ở đâu? Và có bao nhiêu nhân viên?";

type Props = {
  slug: string;
  alreadyConfigured: boolean;
};

export function ManagerBriefingChat({ slug, alreadyConfigured }: Props) {
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", content: GREETING },
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
    setMessages([{ role: "assistant", content: GREETING }]);
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
      const result = await runManagerBriefing({ slug, messages: updated });
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
            {alreadyConfigured
              ? "Cấu hình lại AI Manager (7 câu hỏi)"
              : "Cấu hình AI Manager lần đầu (7 câu hỏi)"}
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
