"use client";

import { useState, useTransition } from "react";
import {
  approveWinbackSuggestion,
  dismissWinbackSuggestion,
} from "@/shared/winback/winbackActions";
import type { WinbackSuggestion } from "@/shared/winback/winbackActions";

const KIND_LABEL: Record<"lapsed" | "due", { en: string; vi: string; icon: string }> = {
  lapsed: { en: "Win-back", vi: "Kéo về", icon: "🔄" },
  due: { en: "Rebook nudge", vi: "Nhắc tái ghé", icon: "⏰" },
};

const CHANNEL_ICON: Record<"sms" | "email", string> = { sms: "💬", email: "✉️" };

function timeAgo(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "vừa xong";
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} giờ trước`;
  return `${Math.floor(h / 24)} ngày trước`;
}

function SuggestionCard({
  item,
  slug,
  onDone,
}: {
  item: WinbackSuggestion;
  slug: string;
  onDone: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.message);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const kind = (item.kind ?? "lapsed") as "lapsed" | "due";
  const channel = (item.channel ?? "sms") as "sms" | "email";
  const meta = KIND_LABEL[kind];

  function approve() {
    setFeedback(null);
    startTransition(async () => {
      const res = await approveWinbackSuggestion(slug, item.id, draft !== item.message ? draft : undefined);
      if (res.ok) {
        onDone(item.id);
      } else {
        setFeedback(res.error);
      }
    });
  }

  function dismiss() {
    setFeedback(null);
    startTransition(async () => {
      const res = await dismissWinbackSuggestion(slug, item.id);
      if (res.ok) {
        onDone(item.id);
      } else {
        setFeedback(res.error);
      }
    });
  }

  return (
    <div className="rounded-xl border border-nq-border/30 bg-nq-surface/40 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-nq-foreground">
            {item.client_name}
          </p>
          <p className="text-xs text-nq-muted mt-0.5">
            <span className="mr-1">{meta.icon}</span>
            {meta.vi}
            <span className="mx-1.5 opacity-40">·</span>
            <span>{CHANNEL_ICON[channel]} {channel === "sms" ? item.client_phone : item.client_email}</span>
            <span className="mx-1.5 opacity-40">·</span>
            {timeAgo(item.created_at)}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-nq-warning/15 px-2 py-0.5 text-[10px] font-semibold text-nq-warning uppercase tracking-wide">
          Chờ duyệt
        </span>
      </div>

      {/* Message — editable */}
      {editing ? (
        <textarea
          className="w-full rounded-lg border border-nq-border/40 bg-nq-bg p-3 text-sm text-nq-foreground resize-none focus:outline-none focus:ring-2 focus:ring-nq-primary/40"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={480}
        />
      ) : (
        <p
          className="text-sm text-nq-foreground/80 leading-relaxed cursor-pointer hover:opacity-80"
          onClick={() => setEditing(true)}
          title="Nhấn để chỉnh sửa"
        >
          {draft}
        </p>
      )}

      {feedback && (
        <p className="text-xs text-nq-error">{feedback}</p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2">
        {editing && (
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-xs text-nq-muted hover:text-nq-foreground transition-colors"
            disabled={pending}
          >
            Xong chỉnh
          </button>
        )}
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs text-nq-muted hover:text-nq-foreground transition-colors"
            disabled={pending}
          >
            Chỉnh sửa
          </button>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={dismiss}
          disabled={pending}
          className="rounded-lg border border-nq-border/40 px-3 py-1.5 text-xs font-medium text-nq-muted hover:text-nq-foreground transition-colors disabled:opacity-40"
        >
          Bỏ qua
        </button>
        <button
          type="button"
          onClick={approve}
          disabled={pending || draft.trim().length === 0}
          className="rounded-lg bg-nq-primary px-4 py-1.5 text-xs font-semibold text-white hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          {pending ? "Đang gửi…" : `Gửi qua ${channel === "sms" ? "SMS" : "Email"}`}
        </button>
      </div>
    </div>
  );
}

export function WinbackSuggestionsPanel({
  slug,
  initialItems,
}: {
  slug: string;
  initialItems: WinbackSuggestion[];
}) {
  const [items, setItems] = useState<WinbackSuggestion[]>(initialItems);

  function remove(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  if (items.length === 0) return null;

  return (
    <section className="mb-6 rounded-2xl border border-nq-warning/30 bg-nq-warning/5 p-4">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-base" aria-hidden>💌</span>
        <p className="text-sm font-semibold text-nq-foreground">
          {items.length} tin nhắn AI chờ duyệt
        </p>
        <span className="ml-auto rounded-full bg-nq-warning/20 px-2 py-0.5 text-[10px] font-bold text-nq-warning">
          {items.length}
        </span>
      </div>
      <p className="text-xs text-nq-muted mb-4">
        AI đã soạn sẵn — xem lại, chỉnh nếu muốn, rồi Gửi hoặc Bỏ qua.
        Tin chỉ đến tay khách sau khi bạn bấm <strong>Gửi</strong>.
      </p>
      <div className="space-y-3">
        {items.map((item) => (
          <SuggestionCard key={item.id} item={item} slug={slug} onDone={remove} />
        ))}
      </div>
    </section>
  );
}
