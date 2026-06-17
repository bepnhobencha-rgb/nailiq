"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { getSiteUrl } from "@/shared/seo/site";

function RegisterSuccessInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const slug = searchParams.get("slug")?.trim() ?? "";
  const slugAdjusted = searchParams.get("adjusted") === "1";

  const { language } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language).register.success, [
    language,
  ]);

  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!slug) {
      router.replace("/register/setup");
    }
  }, [slug, router]);

  const bookingHref = slug ? `/${encodeURIComponent(slug)}` : "";

  const bookingAbsoluteUrl = useMemo(() => {
    if (!slug) return "";
    const base = getSiteUrl().replace(/\/$/, "");
    return `${base}/${encodeURIComponent(slug)}`;
  }, [slug]);

  const copy = useCallback(async () => {
    if (!bookingAbsoluteUrl) return;
    try {
      await navigator.clipboard.writeText(bookingAbsoluteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }, [bookingAbsoluteUrl]);

  const openBooking = useCallback(() => {
    if (!bookingHref) return;
    router.push(bookingHref);
  }, [bookingHref, router]);

  if (!slug) {
    return (
      <RegisterStepShell title={t.title}>
        <div className="h-40 rounded-2xl bg-nq-surface/50" />
      </RegisterStepShell>
    );
  }

  // `slugAdjusted` carries a `{slug}` placeholder so VI/EN can keep the
  // salon's chosen URL highlighted in the middle of the sentence. Split
  // on the marker rather than dangerouslySetInnerHTML.
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

        <p className="text-center text-[15px] font-medium leading-snug text-nq-foreground">
          {t.callout}
        </p>

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
              router.push(`/dashboard/${encodeURIComponent(slug)}`)
            }
          >
            {t.goToDashboard}
          </Button>
          <p className="mt-3 text-[12px] leading-snug text-nq-muted">
            {t.dashboardHint}
          </p>
        </div>

        <div>
          <p className="mb-2 text-center text-xs text-nq-muted sm:text-sm">
            {t.bookingLinkLabel}
          </p>
          <div className="break-all rounded-2xl border border-nq-border/40 bg-nq-surface/50 px-4 py-3 text-center text-sm text-nq-foreground/95 sm:text-base">
            {bookingAbsoluteUrl}
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:gap-3">
          <Button
            type="button"
            size="lg"
            variant="primary"
            className="w-full min-w-0"
            onClick={copy}
          >
            {copied ? t.copied : t.copyLink}
          </Button>
          <Button
            type="button"
            size="lg"
            variant="secondary"
            className="w-full min-w-0"
            onClick={openBooking}
          >
            {t.testBookingNow}
          </Button>
        </div>

        <p className="pt-1 text-center text-sm leading-relaxed text-nq-muted">
          {t.homeBookmarkPrefix}
          <Link
            href="/"
            className="text-nq-primary-soft/95 underline decoration-nq-primary/30 underline-offset-2 transition-opacity hover:opacity-90"
          >
            {t.homeBookmarkLinkText}
          </Link>
          {t.homeBookmarkSuffix}
        </p>
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
