"use client";

import { Check, Save } from "lucide-react";
import { useState, useTransition } from "react";

import { postAiControl } from "@/shared/ai/aiControlApi";

export function ReactivationCampaignDraftEditor({
  slug,
  approvalId,
  initialMessageEn,
  initialMessageVi,
}: {
  slug: string;
  approvalId: string;
  initialMessageEn: string;
  initialMessageVi: string;
}) {
  const [messageEn, setMessageEn] = useState(initialMessageEn);
  const [messageVi, setMessageVi] = useState(initialMessageVi);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [pending, startTransition] = useTransition();
  const canSave =
    messageEn.trim().length >= 20 && messageVi.trim().length >= 20;

  const save = () => {
    setStatus("idle");
    startTransition(async () => {
      const result = await postAiControl(slug, {
        action: "save_reactivation_campaign_draft",
        approvalId,
        messageEn,
        messageVi,
      });
      setStatus(result.ok ? "saved" : "error");
    });
  };

  return (
    <div className="space-y-3">
      <label
        htmlFor={`reactivation-en-${approvalId}`}
        className="text-xs font-semibold text-nq-foreground"
      >
        English message
      </label>
      <textarea
        id={`reactivation-en-${approvalId}`}
        value={messageEn}
        maxLength={480}
        rows={4}
        onChange={(event) => {
          setMessageEn(event.target.value);
          setStatus("idle");
        }}
        className="w-full rounded-xl border border-nq-border bg-nq-surface px-3 py-2 text-sm leading-relaxed text-nq-foreground outline-none focus:border-nq-primary focus:ring-2 focus:ring-nq-primary/20"
      />
      <label
        htmlFor={`reactivation-vi-${approvalId}`}
        className="text-xs font-semibold text-nq-foreground"
      >
        Nội dung tiếng Việt
      </label>
      <textarea
        id={`reactivation-vi-${approvalId}`}
        value={messageVi}
        maxLength={480}
        rows={4}
        onChange={(event) => {
          setMessageVi(event.target.value);
          setStatus("idle");
        }}
        className="w-full rounded-xl border border-nq-border bg-nq-surface px-3 py-2 text-sm leading-relaxed text-nq-foreground outline-none focus:border-nq-primary focus:ring-2 focus:ring-nq-primary/20"
      />
      <p className="text-[11px] leading-relaxed text-nq-muted">
        Đây chỉ là bản nháp. Duyệt bước này không đọc hoặc liên hệ khách. Danh
        sách khách và consent được chuẩn bị riêng, rồi chủ tiệm phải duyệt lần
        hai. Dispatch vẫn khóa và không có “undo” sau khi gửi.
      </p>
      <button
        type="button"
        disabled={pending || !canSave}
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
      {status === "error" ? (
        <p role="alert" className="text-xs text-nq-error">
          Không thể lưu. Không nhập đường dẫn, thông tin liên hệ, ưu đãi, hoàn
          tiền hoặc lời hứa chưa được phê duyệt.
        </p>
      ) : null}
    </div>
  );
}
