"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";

function RegisterSuccessInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const slug = searchParams.get("slug")?.trim() ?? "";
  const slugAdjusted = searchParams.get("adjusted") === "1";

  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!slug) {
      router.replace("/register/setup");
    }
  }, [slug, router]);

  const bookingHref = slug ? `/${encodeURIComponent(slug)}` : "";

  const bookingAbsoluteUrl = useMemo(() => {
    if (!slug) return "";
    const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim();
    const siteUrl =
      raw?.replace(/\/$/, "") ??
      (typeof window !== "undefined" ? window.location.origin : "");
    return `${siteUrl}/${encodeURIComponent(slug)}`;
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
      <RegisterStepShell title="Your salon is live!">
        <div className="h-40 rounded-2xl bg-nq-surface/50" />
      </RegisterStepShell>
    );
  }

  return (
    <RegisterStepShell
      title="Your salon is live!"
      subtext="You can take bookings immediately — share your link anywhere clients already message you."
    >
      <div className="flex flex-col gap-5">
        {slugAdjusted ? (
          <p className="rounded-2xl border border-nq-border/50 bg-nq-surface/40 px-4 py-3 text-center text-sm leading-relaxed text-nq-muted">
            Your first-choice URL was taken, so we reserved{" "}
            <span className="font-medium text-nq-foreground/95">{slug}</span> for
            you.
          </p>
        ) : null}

        <p className="text-center text-[15px] font-medium leading-snug text-nq-foreground">
          Guests book on your page now — open it once to confirm everything feels right,
          then drop the link in Instagram or SMS.
        </p>

        <div className="rounded-2xl border border-nq-primary/35 bg-nq-primary/[0.08] px-4 py-4 text-center">
          <p className="text-xs font-medium uppercase tracking-wide text-nq-muted">
            Salon owner
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
            Go to Dashboard
          </Button>
          <p className="mt-3 text-[12px] leading-snug text-nq-muted">
            If your profile isn&apos;t complete yet, the dashboard shows a setup
            checklist (services, staff, hours, address) before real bookings are
            recommended.
          </p>
          <p className="mt-2 text-[11px] leading-snug text-nq-muted/90">
            Production: same browser as OTP signup keeps your session. Demo OTP uses a
            short-lived cookie instead of signing in.
          </p>
        </div>

        <div>
          <p className="mb-2 text-center text-xs text-nq-muted sm:text-sm">
            Public booking link
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
            {copied ? "Copied" : "Copy link"}
          </Button>
          <Button
            type="button"
            size="lg"
            variant="secondary"
            className="w-full min-w-0"
            onClick={openBooking}
          >
            Test booking now
          </Button>
        </div>

        <p className="pt-1 text-center text-sm leading-relaxed text-nq-muted">
          Home later? Bookmark{" "}
          <Link
            href="/"
            className="text-nq-primary-soft/95 underline decoration-nq-primary/30 underline-offset-2 transition-opacity hover:opacity-90"
          >
            NailIQ home
          </Link>
          .
        </p>
      </div>
    </RegisterStepShell>
  );
}

export default function RegisterSuccessPage() {
  return (
    <Suspense
      fallback={
        <RegisterStepShell title="Your salon is live!">
          <div className="h-40 rounded-2xl bg-nq-surface/50" />
        </RegisterStepShell>
      }
    >
      <RegisterSuccessInner />
    </Suspense>
  );
}
