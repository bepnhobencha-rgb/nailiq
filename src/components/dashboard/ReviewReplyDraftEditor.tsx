"use client";

import { Check, Clipboard, Save } from "lucide-react";
import { useState, useTransition } from "react";

import { postAiControl } from "@/shared/ai/aiControlApi";

export function ReviewReplyDraftEditor({
  slug,
  approvalId,
  initialDraft,
}: {
  slug: string;
  approvalId: string;
  initialDraft: string;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [status, setStatus] = useState<"idle" | "saved" | "copied" | "error">(
    "idle",
  );
  const [pending, startTransition] = useTransition();

  const save = () => {
    setStatus("idle");
    startTransition(async () => {
      const result = await postAiControl(slug, {
        action: "save_review_reply_draft",
        approvalId,
        draftReply: draft,
      });
      setStatus(result.ok ? "saved" : "error");
    });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setStatus("copied");
    } catch {
      setStatus("error");
    }
  };

  return (
    <div className="mb-4 space-y-2">
      <label
        htmlFor={`review-reply-${approvalId}`}
        className="text-xs font-semibold text-nq-foreground"
      >
        Nháp trả lời — chỉnh sửa trước khi duyệt hoặc sao chép
      </label>
      <textarea
        id={`review-reply-${approvalId}`}
        value={draft}
        maxLength={800}
        rows={5}
        onChange={(event) => {
          setDraft(event.target.value);
          setStatus("idle");
        }}
        className="w-full rounded-xl border border-nq-border bg-nq-surface px-3 py-2 text-sm leading-relaxed text-nq-foreground outline-none focus:border-nq-primary focus:ring-2 focus:ring-nq-primary/20"
      />
      <p className="text-[11px] text-nq-muted">
        NailIQ không tự đăng và không tự gửi email. Sau khi duyệt, bạn vẫn phải
        sao chép nội dung sang Google Business Profile.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending || draft.trim().length < 10}
          onClick={save}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-nq-border px-3 text-sm font-semibold text-nq-foreground disabled:opacity-50"
        >
          {status === "saved" ? (
            <Check className="h-4 w-4" aria-hidden />
          ) : (
            <Save className="h-4 w-4" aria-hidden />
          )}
          {pending ? "Đang lưu…" : status === "saved" ? "Đã lưu" : "Lưu nháp"}
        </button>
        <button
          type="button"
          disabled={draft.trim().length < 10}
          onClick={copy}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-nq-border px-3 text-sm font-semibold text-nq-foreground disabled:opacity-50"
        >
          <Clipboard className="h-4 w-4" aria-hidden />
          {status === "copied" ? "Đã sao chép" : "Sao chép"}
        </button>
      </div>
      {status === "error" ? (
        <p role="alert" className="text-xs text-nq-error">
          Không thể lưu hoặc sao chép. Kiểm tra nội dung và thử lại.
        </p>
      ) : null}
    </div>
  );
}
