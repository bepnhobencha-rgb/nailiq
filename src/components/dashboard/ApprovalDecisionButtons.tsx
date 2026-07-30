"use client";

import { Check, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { postAiControl } from "@/shared/ai/aiControlApi";

export function ApprovalDecisionButtons({
  slug,
  approvalId,
  language = "vi",
}: {
  slug: string;
  approvalId: string;
  language?: "en" | "vi";
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const vi = language === "vi";

  const decide = (decision: "approved" | "declined") => {
    setError(null);
    startTransition(async () => {
      const result = await postAiControl(slug, {
        action: "decide_approval",
        approvalId,
        decision,
      });
      if (!result.ok) {
        setError(
          result.error === "already_decided"
            ? vi ? "Yêu cầu đã được xử lý." : "This request was already decided."
            : result.error === "expired"
              ? vi ? "Yêu cầu đã hết hạn." : "This request has expired."
              : vi ? "Không thể ghi quyết định. Vui lòng thử lại." : "Could not record the decision. Try again.",
        );
        router.refresh();
        return;
      }
      router.refresh();
    });
  };

  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => decide("approved")}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-nq-success px-3 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60"
        >
          <Check className="h-4 w-4" aria-hidden />
          {pending ? (vi ? "Đang ghi…" : "Saving…") : (vi ? "Đồng ý" : "Approve")}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => decide("declined")}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-nq-error/40 px-3 text-sm font-semibold text-nq-error disabled:cursor-wait disabled:opacity-60"
        >
          <X className="h-4 w-4" aria-hidden />
          {vi ? "Từ chối" : "Decline"}
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-nq-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
