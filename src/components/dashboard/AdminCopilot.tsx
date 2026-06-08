"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Sparkles,
  X,
  Send,
  Loader2,
  RotateCcw,
  MessageCircleQuestion,
  ArrowRight,
  ExternalLink,
} from "lucide-react";

// Coco — the in-admin agentic assistant for the salon dashboard. It guides and
// reads only; any "do it for me" is rendered as a deep-link to the page where
// the real, validated action button lives. Styling matches the NailIQ dark/gold
// design tokens (nq-*). Bilingual EN/VI driven by the user-language cookie.

type Lang = "en" | "vi";
type Msg = { role: "user" | "assistant"; content: string };

const COPY = {
  fab: { en: "Ask Coco", vi: "Hỏi Coco" },
  title: { en: "Coco", vi: "Coco" },
  subtitle: { en: "NailIQ assistant · here to help", vi: "Trợ lý NailIQ · luôn sẵn sàng" },
  greeting: {
    en: "Hi, I'm Coco — your NailIQ assistant! I can see your salon's setup and what's happening today, so ask me how to do anything, or just \"what needs my attention right now?\"",
    vi: "Chào bạn, Coco đây — trợ lý của NailIQ! Coco nhìn được cấu hình & tình hình hôm nay của tiệm, nên cứ hỏi Coco cách làm bất cứ việc gì, hoặc \"tiệm cần làm gì bây giờ?\"",
  },
  placeholder: { en: "Type your question…", vi: "Nhập câu hỏi của bạn…" },
  thinking: { en: "Coco is checking your salon…", vi: "Coco đang xem tiệm của bạn…" },
  clear: { en: "New chat", vi: "Hỏi mới" },
  suggestionsLabel: { en: "Try asking", vi: "Thử hỏi" },
  errorGeneric: { en: "Something went wrong. Please try again.", vi: "Có lỗi xảy ra. Vui lòng thử lại." },
};

const SUGGESTIONS: Record<Lang, string[]> = {
  vi: [
    "Tiệm cần làm gì bây giờ?",
    "Có khách walk-in nào đang chờ không?",
    "Làm sao đánh dấu khách no-show?",
    "Cách thêm thợ mới và dịch vụ?",
    "Tiệm đã sẵn sàng nhận đặt lịch chưa?",
  ],
  en: [
    "What does my salon need right now?",
    "Any walk-ins waiting?",
    "How do I mark a no-show?",
    "How do I add a new staff and service?",
    "Is my salon ready to take bookings?",
  ],
};

function readLangCookie(): Lang {
  if (typeof document === "undefined") return "en";
  const m = document.cookie.match(/(?:^|;\s*)nailiq-user-lang=([^;]+)/);
  return m && decodeURIComponent(m[1]).toLowerCase().startsWith("vi") ? "vi" : "en";
}

const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/;
const TOKEN_RE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

function renderInline(text: string, nav: (href: string) => void): React.ReactNode[] {
  const parts = text.split(TOKEN_RE);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) {
      return <strong key={i} className="font-semibold text-nq-foreground">{p.slice(2, -2)}</strong>;
    }
    if (p.startsWith("`") && p.endsWith("`")) {
      return <code key={i} className="px-1 py-0.5 rounded bg-nq-bg text-nq-primary text-[0.85em]">{p.slice(1, -1)}</code>;
    }
    const link = p.match(LINK_RE);
    if (link) {
      const [, label, href] = link;
      const internal = href.startsWith("/");
      return (
        <a
          key={i}
          href={href}
          onClick={(e) => { if (internal) { e.preventDefault(); nav(href); } }}
          target={internal ? undefined : "_blank"}
          rel={internal ? undefined : "noreferrer"}
          className="text-nq-primary underline decoration-nq-border underline-offset-2 hover:opacity-80"
        >
          {label}
        </a>
      );
    }
    return <span key={i}>{p}</span>;
  });
}

// A line that is ONLY a link becomes a prominent action button — the copilot's
// "do it for me" deep-link to the page where the real action lives.
function LinkButton({ label, href, nav }: { label: string; href: string; nav: (h: string) => void }) {
  const internal = href.startsWith("/");
  return (
    <a
      href={href}
      onClick={(e) => { if (internal) { e.preventDefault(); nav(href); } }}
      target={internal ? undefined : "_blank"}
      rel={internal ? undefined : "noreferrer"}
      className="my-1.5 inline-flex items-center gap-1.5 rounded-xl bg-nq-primary text-nq-bg text-sm font-medium px-3.5 py-2 hover:opacity-90 transition-opacity"
    >
      {label}
      {internal ? <ArrowRight className="w-4 h-4" /> : <ExternalLink className="w-3.5 h-3.5" />}
    </a>
  );
}

function Markdown({ text, nav }: { text: string; nav: (href: string) => void }) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flush = (key: string) => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    const cur = list;
    blocks.push(
      <Tag key={key} className={cur.ordered ? "list-decimal pl-5 space-y-1 my-1.5" : "list-disc pl-5 space-y-1 my-1.5"}>
        {cur.items.map((it, i) => <li key={i}>{renderInline(it, nav)}</li>)}
      </Tag>,
    );
    list = null;
  };

  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    const hr = line.trim().match(/^(-{3,}|\*{3,}|_{3,})$/);
    const quote = line.match(/^\s*>\s+(.*)$/);
    const ordered = line.match(/^\s*(\d+)\.\s+(.*)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const onlyLink = line.trim().match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (onlyLink) {
      flush(`b${idx}`);
      blocks.push(<LinkButton key={`l${idx}`} label={onlyLink[1]} href={onlyLink[2]} nav={nav} />);
    } else if (hr) {
      flush(`b${idx}`);
      blocks.push(<hr key={`h${idx}`} className="my-2.5 border-nq-border" />);
    } else if (heading) {
      flush(`b${idx}`);
      blocks.push(<p key={`hd${idx}`} className="mt-2.5 mb-1 font-semibold text-nq-foreground">{renderInline(heading[1], nav)}</p>);
    } else if (quote) {
      flush(`b${idx}`);
      blocks.push(
        <p key={`q${idx}`} className="my-1.5 pl-3 border-l-2 border-nq-primary/50 text-nq-muted py-1">
          {renderInline(quote[1], nav)}
        </p>,
      );
    } else if (ordered) {
      if (!list || !list.ordered) { flush(`b${idx}`); list = { ordered: true, items: [] }; }
      list.items.push(ordered[2]);
    } else if (bullet) {
      if (!list || list.ordered) { flush(`b${idx}`); list = { ordered: false, items: [] }; }
      list.items.push(bullet[1]);
    } else {
      flush(`b${idx}`);
      if (line.trim()) blocks.push(<p key={`p${idx}`} className="my-1">{renderInline(line, nav)}</p>);
    }
  });
  flush("bend");
  return <div className="text-sm leading-relaxed text-nq-foreground/90">{blocks}</div>;
}

export function AdminCopilot({ slug }: { slug: string; role?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState<Lang>("en");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Read the user-language cookie after mount. Deliberately done in an effect
  // (not a lazy initializer) so the server and client first render both use
  // "en" — that keeps hydration stable; the cookie value is applied right after.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setLang(readLangCookie()); }, []);

  const nav = useCallback((href: string) => { setOpen(false); router.push(href); }, [router]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const send = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || loading) return;
      setInput("");
      const next: Msg[] = [...messages, { role: "user", content: q }];
      setMessages(next);
      setLoading(true);
      try {
        const res = await fetch("/api/dashboard/copilot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, messages: next, lang, path: pathname }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const err = (data as { error?: string }).error || COPY.errorGeneric[lang];
          setMessages((m) => [...m, { role: "assistant", content: `⚠️ ${err}` }]);
          return;
        }
        setMessages((m) => [...m, { role: "assistant", content: (data as { text: string }).text || COPY.errorGeneric[lang] }]);
      } catch {
        setMessages((m) => [...m, { role: "assistant", content: `⚠️ ${COPY.errorGeneric[lang]}` }]);
      } finally {
        setLoading(false);
      }
    },
    [messages, loading, lang, pathname, slug],
  );

  return (
    <>
      {/* Floating action button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-20 right-5 md:bottom-5 z-50 flex items-center gap-2 rounded-full bg-nq-primary text-nq-bg pl-3.5 pr-4 py-3 shadow-nq-card hover:opacity-90 transition-all hover:scale-105 active:scale-95"
          aria-label={COPY.fab[lang]}
        >
          <Sparkles className="w-5 h-5" />
          <span className="text-sm font-semibold">{COPY.fab[lang]}</span>
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className="fixed inset-0 z-50 sm:inset-auto sm:bottom-5 sm:right-5 flex sm:block items-end">
          <button className="absolute inset-0 bg-black/40 sm:hidden" onClick={() => setOpen(false)} aria-label="Close" />
          <div className="relative w-full sm:w-[380px] h-[80vh] sm:h-[560px] bg-nq-surface sm:rounded-2xl shadow-nq-card border border-nq-border flex flex-col overflow-hidden animate-[cocoUp_0.2s_ease-out]">
            {/* Header */}
            <div className="flex items-center gap-2.5 px-4 py-3 bg-nq-bg border-b border-nq-border shrink-0">
              <div className="w-9 h-9 rounded-full bg-nq-primary/15 flex items-center justify-center">
                <Sparkles className="w-5 h-5 text-nq-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm leading-tight text-nq-foreground">{COPY.title[lang]}</p>
                <p className="text-[11px] text-nq-muted leading-tight truncate">{COPY.subtitle[lang]}</p>
              </div>
              {messages.length > 0 && (
                <button onClick={() => setMessages([])} title={COPY.clear[lang]} className="p-1.5 rounded-md hover:bg-nq-border/40 text-nq-muted transition-colors">
                  <RotateCcw className="w-4 h-4" />
                </button>
              )}
              <button onClick={() => setOpen(false)} className="p-1.5 rounded-md hover:bg-nq-border/40 text-nq-muted transition-colors" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Messages */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-3.5 py-4 space-y-3 bg-nq-surface">
              {messages.length === 0 && (
                <div className="space-y-4">
                  <div className="flex gap-2.5">
                    <div className="w-7 h-7 rounded-full bg-nq-primary/15 flex items-center justify-center shrink-0">
                      <MessageCircleQuestion className="w-4 h-4 text-nq-primary" />
                    </div>
                    <div className="bg-nq-bg rounded-2xl rounded-tl-sm px-3.5 py-2.5 border border-nq-border text-sm text-nq-foreground/90 leading-relaxed">
                      {COPY.greeting[lang]}
                    </div>
                  </div>
                  <div className="pl-10">
                    <p className="text-[11px] uppercase tracking-wide text-nq-muted mb-1.5">{COPY.suggestionsLabel[lang]}</p>
                    <div className="flex flex-col gap-1.5">
                      {SUGGESTIONS[lang].map((sug) => (
                        <button
                          key={sug}
                          onClick={() => send(sug)}
                          className="text-left text-sm text-nq-foreground/80 bg-nq-bg border border-nq-border rounded-xl px-3 py-2 hover:border-nq-primary/50 transition-colors"
                        >
                          {sug}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {messages.map((m, i) => (
                <div key={i} className={m.role === "user" ? "flex justify-end" : "flex gap-2.5"}>
                  {m.role === "assistant" && (
                    <div className="w-7 h-7 rounded-full bg-nq-primary/15 flex items-center justify-center shrink-0">
                      <Sparkles className="w-4 h-4 text-nq-primary" />
                    </div>
                  )}
                  <div
                    className={
                      m.role === "user"
                        ? "max-w-[80%] bg-nq-primary text-nq-bg rounded-2xl rounded-tr-sm px-3.5 py-2.5 text-sm whitespace-pre-wrap"
                        : "max-w-[85%] bg-nq-bg rounded-2xl rounded-tl-sm px-3.5 py-2.5 border border-nq-border"
                    }
                  >
                    {m.role === "user" ? m.content : <Markdown text={m.content} nav={nav} />}
                  </div>
                </div>
              ))}

              {loading && (
                <div className="flex gap-2.5">
                  <div className="w-7 h-7 rounded-full bg-nq-primary/15 flex items-center justify-center shrink-0">
                    <Sparkles className="w-4 h-4 text-nq-primary" />
                  </div>
                  <div className="bg-nq-bg rounded-2xl rounded-tl-sm px-3.5 py-2.5 border border-nq-border">
                    <span className="flex items-center gap-1.5 text-sm text-nq-muted">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> {COPY.thinking[lang]}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Input */}
            <form
              onSubmit={(e) => { e.preventDefault(); send(input); }}
              className="shrink-0 border-t border-nq-border p-2.5 flex items-end gap-2 bg-nq-bg"
            >
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
                rows={1}
                placeholder={COPY.placeholder[lang]}
                className="flex-1 resize-none max-h-28 px-3 py-2 rounded-xl border border-nq-border bg-nq-surface text-nq-foreground text-sm placeholder:text-nq-muted focus:outline-none focus:ring-2 focus:ring-nq-primary/50 focus:border-transparent"
              />
              <button
                type="submit"
                disabled={!input.trim() || loading}
                className="shrink-0 w-10 h-10 rounded-xl bg-nq-primary text-nq-bg flex items-center justify-center hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                aria-label="Send"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </form>
          </div>
        </div>
      )}

      <style jsx global>{`
        @keyframes cocoUp {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </>
  );
}
