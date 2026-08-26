"use client";

import { Check, Save } from "lucide-react";
import { useState, useTransition } from "react";

import { postAiControl } from "@/shared/ai/aiControlApi";
import { promoCampaignHasOfferFacts } from "@/shared/ai/promoCampaignPolicy";

export function PromoCampaignDraftEditor({
  slug,
  approvalId,
  initialMessage,
  initialOfferFactsConfirmed,
}: {
  slug: string;
  approvalId: string;
  initialMessage: string;
  initialOfferFactsConfirmed: boolean;
}) {
  const [message, setMessage] = useState(initialMessage);
  const [offerFactsConfirmed, setOfferFactsConfirmed] = useState(
    initialOfferFactsConfirmed,
  );
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [pending, startTransition] = useTransition();
  const hasOfferFacts = promoCampaignHasOfferFacts(message);
  const canSave =
    message.trim().length >= 20 && (!hasOfferFacts || offerFactsConfirmed);

  const save = () => {
    setStatus("idle");
    startTransition(async () => {
      const result = await postAiControl(slug, {
        action: "save_promo_campaign_draft",
        approvalId,
        draftMessage: message,
        offerFactsConfirmed: hasOfferFacts && offerFactsConfirmed,
      });
      setStatus(result.ok ? "saved" : "error");
    });
  };

  return (
    <div className="space-y-3">
      <label
        htmlFor={`promo-campaign-${approvalId}`}
        className="text-xs font-semibold text-nq-foreground"
      >
        Nội dung chiến dịch — chỉnh sửa trước khi duyệt
      </label>
      <textarea
        id={`promo-campaign-${approvalId}`}
        value={message}
        maxLength={1000}
        rows={6}
        onChange={(event) => {
          setMessage(event.target.value);
          setOfferFactsConfirmed(false);
          setStatus("idle");
        }}
        className="w-full rounded-xl border border-nq-border bg-nq-surface px-3 py-2 text-sm leading-relaxed text-nq-foreground outline-none focus:border-nq-primary focus:ring-2 focus:ring-nq-primary/20"
      />
      {hasOfferFacts ? (
        <label className="flex min-h-11 items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          <input
            type="checkbox"
            checked={offerFactsConfirmed}
            onChange={(event) => {
              setOfferFactsConfirmed(event.target.checked);
              setStatus("idle");
            }}
            className="mt-0.5 h-4 w-4 shrink-0"
          />
          Tôi xác nhận mọi giá, mức giảm, ngày, giờ và dịch vụ trong nội dung này
          là thông tin do tiệm cấu hình hoặc do tôi trực tiếp nhập và kiểm tra.
        </label>
      ) : null}
      <p className="text-[11px] leading-relaxed text-nq-muted">
        Đây chỉ là bản nháp trong NailIQ. Duyệt bản nháp không gửi email/SMS,
        không đăng bài, không tạo hoặc kích hoạt khuyến mãi. Audience và consent
        được kiểm tra ở bước riêng; dispatch hiện vẫn khóa.
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
          Không thể lưu. Kiểm tra nội dung và xác nhận thông tin ưu đãi rồi thử
          lại.
        </p>
      ) : null}
    </div>
  );
}
