"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";
import type { BookingMessages } from "@/shared/i18n/booking/en";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

function MessageBubble({
  msg,
  isTyping,
}: {
  msg: ChatMessage;
  isTyping?: boolean;
}) {
  const isUser = msg.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed",
          isUser
            ? "rounded-br-sm bg-[var(--salon-primary)] text-[var(--booking-bg)]"
            : "rounded-bl-sm bg-[var(--booking-bg-input)] text-[var(--booking-text)]",
          isTyping && "opacity-60",
        )}
      >
        {msg.content}
      </div>
    </div>
  );
}

export function BookingChatWidget({
  salonId,
  t,
}: {
  salonId: string;
  t: BookingMessages;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      inputRef.current?.focus();
    }
  }, [open, messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };
    setInput("");
    setMessages((prev) => [...prev, userMsg]);
    setStreaming(true);

    const assistantId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: "" },
    ]);

    abortRef.current = new AbortController();
    try {
      const res = await fetch("/api/chat/booking", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          salonId,
          messages: [...messages, userMsg].map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok || !res.body) throw new Error("Stream failed");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      while (!done) {
        const { value, done: d } = await reader.read();
        done = d;
        if (value) {
          const chunk = decoder.decode(value, { stream: !done });
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: m.content + chunk }
                : m,
            ),
          );
          bottomRef.current?.scrollIntoView({ behavior: "smooth" });
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: t.chat.errorFallback }
            : m,
        ),
      );
    } finally {
      setStreaming(false);
    }
  }, [input, messages, salonId, streaming, t.chat.errorFallback]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Don't send mid-IME-composition (Vietnamese Telex/VNI): the committing
      // Enter would send + clear, then compositionend re-inserts the last word.
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void send();
      }
    },
    [send],
  );

  return (
    <div className="fixed bottom-6 right-4 z-50 sm:right-6 lg:bottom-8 lg:right-8">
      {/* Chat panel */}
      {open ? (
        <div className="nq-booking-glass mb-3 flex w-[min(340px,calc(100vw-2rem))] flex-col overflow-hidden rounded-3xl border border-[var(--booking-border)] shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[var(--booking-border)] px-4 py-3">
            <span className="text-sm font-semibold text-[var(--booking-text)]">
              {t.chat.heading}
            </span>
            <button
              type="button"
              aria-label="Close chat"
              onClick={() => setOpen(false)}
              className="rounded-full p-1 text-[var(--booking-text-muted)] hover:text-[var(--booking-text)]"
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Messages */}
          <div className="flex max-h-72 flex-col gap-2.5 overflow-y-auto px-3 py-3">
            {messages.length === 0 ? (
              <p className="py-4 text-center text-[12px] text-[var(--booking-text-muted)]">
                {t.chat.placeholder}
              </p>
            ) : (
              messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  msg={msg}
                  isTyping={streaming && msg.role === "assistant" && msg.content === "" && msg.id === messages[messages.length - 1]?.id}
                />
              ))
            )}
            {streaming && messages[messages.length - 1]?.content === "" && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-sm bg-[var(--booking-bg-input)] px-3.5 py-2.5 text-[12px] text-[var(--booking-text-muted)]">
                  {t.chat.typingIndicator}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Disclaimer */}
          <p className="border-t border-[var(--booking-border)] px-3 py-1.5 text-center text-[10px] text-[var(--booking-text-muted)]">
            {t.chat.disclaimer}
          </p>

          {/* Input */}
          <div className="border-t border-[var(--booking-border)] p-2.5">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t.chat.placeholder}
                disabled={streaming}
                className="min-h-[36px] flex-1 resize-none rounded-xl bg-[var(--booking-bg-input)] px-3 py-2 text-[13px] text-[var(--booking-text)] placeholder-[var(--booking-text-muted)] outline-none focus:ring-1 focus:ring-[var(--salon-primary)]"
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={!input.trim() || streaming}
                aria-label={t.chat.send}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--salon-primary)] text-[var(--booking-bg)] disabled:opacity-40"
              >
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t.chat.trigger}
        aria-expanded={open}
        className="ml-auto flex items-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--salon-primary)_35%,transparent)] bg-[var(--booking-bg-card)] px-4 py-2.5 text-[13px] font-medium text-[var(--salon-primary)] shadow-lg hover:bg-[var(--booking-bg-input)]"
      >
        <svg
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        {t.chat.trigger}
      </button>
    </div>
  );
}
