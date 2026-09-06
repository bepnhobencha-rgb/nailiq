"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo } from "react";
import { Check, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

function RegisterSuccessInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const slug = searchParams.get("slug")?.trim() ?? "";
  const slugAdjusted = searchParams.get("adjusted") === "1";

  const { language } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language).register.success, [
    language,
  ]);

  useEffect(() => {
    if (!slug) {
      router.replace("/register/setup");
    }
  }, [slug, router]);

  if (!slug) {
    return (
      <RegisterStepShell title={t.title}>
        <div className="h-40 rounded-2xl bg-nq-surface/50" />
      </RegisterStepShell>
    );
  }

  const [slugAdjBefore, slugAdjAfter] = t.slugAdjusted.split("{slug}");

  return (
    <RegisterStepShell title={t.title} subtext={t.subtext} step={{ current: 3, total: 3 }}>
      <div className="flex flex-col gap-5">
        {slugAdjusted ? (
          <p className="rounded-2xl border border-nq-border/50 bg-nq-surface/40 px-4 py-3 text-center text-sm leading-relaxed text-nq-muted">
            {slugAdjBefore}
            <span className="font-medium text-nq-foreground/95">{slug}</span>
            {slugAdjAfter}
          </p>
        ) : null}

        <Card
          variant="bordered"
          padding="md"
          className="border-nq-success/35 bg-nq-success/[0.06]"
          data-testid="registration-launch-status"
        >
          <div className="flex items-start gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-nq-success/15 text-nq-success">
              <ShieldCheck className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-nq-foreground">
                {t.launchStatusTitle}
              </h2>
              <p className="mt-1 text-sm leading-5 text-nq-muted">
                {t.launchStatusBody}
              </p>
            </div>
          </div>
          <ul className="mt-4 flex flex-col gap-2 border-t border-nq-border/35 pt-4">
            {[
              t.launchSafetyBooking,
              t.launchSafetyMessages,
              t.launchSafetyPayments,
            ].map((item) => (
              <li key={item} className="flex items-start gap-2 text-sm text-nq-muted">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-nq-success" aria-hidden />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </Card>

        <div className="rounded-2xl border border-nq-primary/20 bg-nq-primary/[0.06] px-4 py-4">
          <p className="text-sm font-medium leading-snug text-nq-foreground">
            {t.callout}
          </p>
        </div>

        {/* Start Coco Setup — primary CTA */}
        <div className="rounded-2xl border border-nq-primary/35 bg-nq-primary/[0.08] px-4 py-4 text-center">
          <p className="text-xs font-medium uppercase tracking-wide text-nq-muted">
            {t.salonOwnerLabel}
          </p>
          <Button
            type="button"
            size="lg"
            variant="primary"
            className="mt-3 w-full min-h-[48px]"
            onClick={() =>
              router.push(`/dashboard/${encodeURIComponent(slug)}/setup`)
            }
          >
            {t.goToDashboard}
          </Button>
          <p className="mt-3 text-[12px] leading-snug text-nq-muted">
            {t.dashboardHint}
          </p>
        </div>
      </div>
    </RegisterStepShell>
  );
}

export default function RegisterSuccessPage() {
  return (
    <Suspense fallback={<SuccessFallback />}>
      <RegisterSuccessInner />
    </Suspense>
  );
}

function SuccessFallback() {
  const { language } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language).register.success, [
    language,
  ]);
  return (
    <RegisterStepShell title={t.title}>
      <div className="h-40 rounded-2xl bg-nq-surface/50" />
    </RegisterStepShell>
  );
}
