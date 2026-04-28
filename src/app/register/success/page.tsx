"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { RegisterStepShell } from "@/components/register/RegisterStepShell";
import { getSiteUrlForClient } from "@/shared/lib/siteUrlClient";

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
    const base = getSiteUrlForClient().replace(/\/$/, "");
    return `${base}${bookingHref}`;
  }, [slug, bookingHref]);

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

        <div className="rounded-2xl border border-nq-primary/25 bg-nq-primary/8 px-4 py-3 text-center">
          <p className="text-xs font-medium uppercase tracking-wide text-nq-muted">
            Salon owner
          </p>
          <Button
            type="button"
            size="lg"
            variant="secondary"
            className="mt-3 w-full"
            onClick={() => router.push(`/dashboard/${encodeURIComponent(slug)}`)}
          >
            Open dashboard
          </Button>
          <p className="mt-2 text-[11px] leading-snug text-nq-muted">
            Today’s bookings and status — same browser you used to verify your number.
          </p>
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
