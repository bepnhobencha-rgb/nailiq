"use client";

import { useState, useTransition } from "react";
import { cn } from "@/shared/lib/cn";
import { updateBookingVerificationMode } from "@/shared/dashboard/salonOwnerActions";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { getUserMessages } from "@/shared/i18n/user";

type VerificationMode = "never" | "auto" | "always_otp" | "always_deposit" | "deposit_first";

type Props = {
  slug: string;
  initialMode: VerificationMode;
  canEdit: boolean;
  /** Pro+ required for 'auto' mode; Studio+ for deposit modes. */
  plan: "free" | "pro" | "studio" | "enterprise";
};

/**
 * Map each verification mode to its i18n key suffix under
 * `salonSettings.bookingVerify`. Labels/hints are looked up at render time
 * so they follow the active language.
 */
const MODE_I18N: Record<VerificationMode, { labelKey: string; hintKey: string }> = {
  never: { labelKey: "neverLabel", hintKey: "neverHint" },
  auto: { labelKey: "autoLabel", hintKey: "autoHint" },
  always_otp: { labelKey: "otpLabel", hintKey: "otpHint" },
  always_deposit: { labelKey: "depositLabel", hintKey: "depositHint" },
  deposit_first: { labelKey: "depositThenOtpLabel", hintKey: "depositThenOtpHint" },
};

const MODE_OPTIONS: {
  value: VerificationMode;
  minPlan: "free" | "pro" | "studio";
}[] = [
  { value: "never", minPlan: "free" },
  { value: "auto", minPlan: "pro" },
  { value: "always_otp", minPlan: "free" },
  { value: "always_deposit", minPlan: "studio" },
  { value: "deposit_first", minPlan: "studio" },
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
  const { language } = useUserLanguage();
  const t = getUserMessages(language);
  const bv = t.salonSettings.bookingVerify;

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
        setError(bv.saveError);
        setMode(initialMode);
      }
    });
  }

  return (
    <section className="space-y-3 rounded-2xl border border-nq-muted/20 bg-nq-surface p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium text-nq-foreground">{bv.title}</p>
          <p className="text-xs text-nq-muted">{bv.subtitle}</p>
        </div>
        {saved ? (
          <span className="text-xs font-medium text-emerald-400">{bv.saved}</span>
        ) : null}
        {error ? (
          <span className="text-xs text-red-400">{error}</span>
        ) : null}
      </div>

      <div className="space-y-2">
        {MODE_OPTIONS.map((opt) => {
          const allowed = canUsePlan(plan, opt.minPlan);
          const selected = mode === opt.value;
          const labelText = bv[MODE_I18N[opt.value].labelKey as keyof typeof bv];
          const hintText = bv[MODE_I18N[opt.value].hintKey as keyof typeof bv];
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
                  {labelText}
                  {!allowed ? (
                    <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-nq-muted">
                      {opt.minPlan === "pro" ? "Pro+" : "Studio+"}
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-nq-muted">{hintText}</p>
              </div>
            </label>
          );
        })}
      </div>
    </section>
  );
}
