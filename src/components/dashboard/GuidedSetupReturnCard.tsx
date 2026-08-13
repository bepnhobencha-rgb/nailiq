"use client";

import Link from "next/link";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

export function GuidedSetupReturnCard({ slug }: { slug: string }) {
  const { language } = useUserLanguage();
  const vi = language === "vi";

  return (
    <aside
      className="my-5 rounded-2xl border border-nq-primary/45 bg-nq-primary/5 p-4"
      aria-label={vi ? "Tiếp tục thiết lập" : "Continue setup"}
      data-testid="guided-setup-return-card"
    >
      <div className="flex items-start gap-3">
        <CheckCircle2
          className="mt-0.5 h-5 w-5 shrink-0 text-nq-primary"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-nq-foreground">
            {vi
              ? "Dữ liệu của bước này được lưu riêng"
              : "This step saves its own data"}
          </p>
          <p className="mt-1 text-sm leading-6 text-nq-muted">
            {vi
              ? "Quay lại Thiết lập để NailIQ kiểm tra dữ liệu đã lưu và chỉ hiện bước bắt buộc tiếp theo."
              : "Return to Setup so NailIQ can validate the saved data and show only the next required step."}
          </p>
        </div>
      </div>
      <Link
        href={`/dashboard/${encodeURIComponent(slug)}/setup`}
        className="mt-4 inline-flex min-h-11 w-full touch-manipulation items-center justify-center gap-2 rounded-full bg-nq-primary px-4 text-base font-semibold text-nq-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
        data-testid="guided-setup-continue"
      >
        {vi ? "Kiểm tra và tiếp tục" : "Check and continue"}
        <ArrowRight className="h-5 w-5" aria-hidden />
      </Link>
    </aside>
  );
}
