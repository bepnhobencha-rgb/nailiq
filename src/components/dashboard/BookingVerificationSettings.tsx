"use client";

import { useState, useTransition } from "react";
import { cn } from "@/shared/lib/cn";
import { updateBookingVerificationMode } from "@/shared/dashboard/salonOwnerActions";

type VerificationMode = "never" | "auto" | "always_otp" | "always_deposit" | "deposit_first";

type Props = {
  slug: string;
  initialMode: VerificationMode;
  canEdit: boolean;
  /** Pro+ required for 'auto' mode; Studio+ for deposit modes. */
  plan: "free" | "pro" | "studio" | "enterprise";
};

const MODE_OPTIONS: {
  value: VerificationMode;
  label: string;
  labelVi: string;
  hint: string;
  hintVi: string;
  minPlan: "free" | "pro" | "studio";
}[] = [
  {
    value: "never",
    label: "Trust everyone",
    labelVi: "Tin tưởng tất cả",
    hint: "No verification — lowest friction, highest risk.",
    hintVi: "Không xác thực — ít ma sát nhất, rủi ro cao nhất.",
    minPlan: "free",
  },
  {
    value: "auto",
    label: "Smart auto (recommended)",
    labelVi: "Tự động thông minh (khuyến nghị)",
    hint: "Risk-based: trusted customers skip, risky bookings get OTP or deposit.",
    hintVi: "Theo rủi ro: khách quen không cần xác thực, khách rủi ro cần OTP hoặc cọc.",
    minPlan: "pro",
  },
  {
    value: "always_otp",
    label: "Always OTP",
    labelVi: "Luôn yêu cầu OTP",
    hint: "Every booking requires phone verification. Free for customers.",
    hintVi: "Mọi lịch đặt đều cần xác thực số điện thoại. Miễn phí cho khách.",
    minPlan: "free",
  },
  {
    value: "always_deposit",
    label: "Always deposit",
    labelVi: "Luôn yêu cầu đặt cọc",
    hint: "Every booking requires a deposit. Premium feel, maximum commitment.",
    hintVi: "Mọi lịch đặt đều cần đặt cọc. Cao cấp, cam kết tối đa.",
    minPlan: "studio",
  },
  {
    value: "deposit_first",
    label: "Deposit first, OTP fallback",
    labelVi: "Ưu tiên cọc, OTP nếu từ chối",
    hint: "Ask for deposit; if customer skips, require OTP instead.",
    hintVi: "Yêu cầu cọc trước; nếu khách bỏ qua, chuyển sang OTP.",
    minPlan: "studio",
  },
];

const PLAN_RANK: Record<string, number> = {
  free: 0,
  pro: 1,
  studio: 2,
  enterprise: 3,
};

function canUsePlan(userPlan: string, required: string): boolean {
  return (PLAN_RANK[userPlan] ?? 0) >= (PLAN_RANK[required] ?? 0);
}

export function BookingVerificationSettings({ slug, initialMode, canEdit, plan }: Props) {
  const [mode, setMode] = useState<VerificationMode>(initialMode);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleChange(newMode: VerificationMode) {
    if (!canEdit) return;
    if (!canUsePlan(plan, MODE_OPTIONS.find((o) => o.value === newMode)?.minPlan ?? "free")) return;
    setMode(newMode);
    setSaved(false);
    setError(null);

    startTransition(async () => {
      try {
        const result = await updateBookingVerificationMode(slug, newMode);
        if (!result.ok) throw new Error(result.error ?? "save_failed");
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } catch {
        setError("Lưu thất bại — thử lại");
        setMode(initialMode);
      }
    });
  }

  return (
    <section className="space-y-3 rounded-2xl border border-nq-muted/20 bg-nq-surface p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium text-nq-foreground">Xác thực lịch đặt</p>
          <p className="text-xs text-nq-muted">Chọn mức độ xác thực phù hợp với tiệm</p>
        </div>
        {saved ? (
          <span className="text-xs font-medium text-emerald-400">✓ Đã lưu</span>
        ) : null}
        {error ? (
          <span className="text-xs text-red-400">{error}</span>
        ) : null}
      </div>

      <div className="space-y-2">
        {MODE_OPTIONS.map((opt) => {
          const allowed = canUsePlan(plan, opt.minPlan);
          const selected = mode === opt.value;
          return (
            <label
              key={opt.value}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors",
                selected
                  ? "border-nq-primary/50 bg-nq-primary/5"
                  : "border-nq-muted/20 hover:border-nq-muted/40",
                (!canEdit || !allowed || isPending) && "cursor-not-allowed opacity-50",
              )}
            >
              <input
                type="radio"
                name="verification-mode"
                value={opt.value}
                checked={selected}
                disabled={!canEdit || !allowed || isPending}
                onChange={() => handleChange(opt.value)}
                className="mt-0.5 accent-nq-primary"
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-nq-foreground">
                  {opt.labelVi}
                  {!allowed ? (
                    <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-nq-muted">
                      {opt.minPlan === "pro" ? "Pro+" : "Studio+"}
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-nq-muted">{opt.hintVi}</p>
              </div>
            </label>
          );
        })}
      </div>
    </section>
  );
}
