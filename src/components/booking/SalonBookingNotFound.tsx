"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { BookingDocumentEn } from "@/app/[slug]/BookingDocumentEn";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { cn } from "@/shared/lib/cn";
import { REG_SESSION_PHONE_DIGITS_KEY } from "@/shared/lib/registerSessionKeys";
import {
  isRegisterPhoneDigitsValid,
  normalizeRegisterPhone,
} from "@/shared/register/phone";

type SalonBookingNotFoundProps = {
  requestedSlug: string;
  /** Dev-only: sample slugs from DB for debugging */
  sampleSlugs?: string[];
  suggestedSlugs?: string[];
};

export function SalonBookingNotFound({
  requestedSlug,
  sampleSlugs,
  suggestedSlugs,
}: SalonBookingNotFoundProps) {
  const router = useRouter();
  const isDev = process.env.NODE_ENV === "development";

  const onCreateBookingLink = useCallback(() => {
    const el = document.querySelector<HTMLInputElement>('input[name="phone"]');
    const phone = normalizeRegisterPhone(el?.value ?? "");
    if (typeof window !== "undefined" && isRegisterPhoneDigitsValid(phone)) {
      window.sessionStorage.setItem(REG_SESSION_PHONE_DIGITS_KEY, phone);
    }
    router.push("/register");
  }, [router]);

  const linkSecondary = cn(
    "inline-flex min-h-14 w-full cursor-pointer items-center justify-center rounded-full border px-6 text-base font-medium shadow-[0_0_30px_rgba(212,175,55,0.2)] transition-all duration-150 ease-out hover:scale-[1.02] active:scale-[0.98] sm:w-auto",
    "border-nq-border bg-nq-surface text-nq-primary hover:bg-nq-surface/90 focus-visible:ring-2 focus-visible:ring-nq-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg",
  );

  return (
    <>
      <BookingDocumentEn />
      <div className="relative min-h-dvh px-4 py-16 pb-safe sm:px-6">
        <div className="mx-auto max-w-lg text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
            This salon doesn't exist yet
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-nq-muted">
            Create your booking link in 2 minutes and start getting clients
            automatically
          </p>

          {suggestedSlugs && suggestedSlugs.length > 0 ? (
            <div className="mt-8 text-left">
              <p className="text-center text-sm font-medium text-nq-muted">
                Did you mean:
              </p>
              <ul className="mt-4 flex flex-col gap-2">
                {suggestedSlugs.map((s) => (
                  <li key={s}>
                    <Link
                      href={`/${encodeURIComponent(s)}`}
                      className="block rounded-xl border border-nq-border/60 bg-nq-surface/40 px-4 py-3 text-center text-[15px] font-medium text-nq-primary-soft transition-colors hover:bg-nq-surface/60 hover:text-nq-primary"
                    >
                      {s}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="mt-10 flex w-full flex-col">
            <Input
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="Phone (optional — enter before Get started)"
              aria-label="Phone number"
            />
            <Button
              type="button"
              size="lg"
              variant="primary"
              className="mt-4 w-full"
              onClick={onCreateBookingLink}
            >
              Create your booking link
            </Button>
            <p className="mt-3 text-center text-xs text-nq-muted/60">
              Already have a salon?{" "}
              <Link
                href="/register"
                className="text-nq-muted/60 underline decoration-nq-primary/25 underline-offset-2 transition-colors hover:text-nq-primary"
              >
                Sign in →
              </Link>
            </p>

            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
              <Link href="/" className={cn(linkSecondary, "w-full sm:w-auto")}>
                Back to home
              </Link>
            </div>
          </div>
        </div>

        {isDev ? (
          <div className="mx-auto mt-12 max-w-lg rounded-2xl border border-nq-border/60 bg-nq-surface/40 px-4 py-4 text-left text-sm leading-relaxed text-nq-foreground/90">
            <p className="font-medium text-nq-foreground">Debug (dev only)</p>
            <p className="mt-2">
              Requested slug:{" "}
              <code className="rounded bg-nq-surface px-1.5 py-0.5 text-[13px]">
                {requestedSlug || "(empty)"}
              </code>
            </p>
            {sampleSlugs?.length ? (
              <p className="mt-2 break-words">
                Sample slugs in DB:{" "}
                {sampleSlugs.map((s) => (
                  <code
                    key={s}
                    className="mr-1 inline rounded bg-nq-surface px-1 py-0.5 text-[13px] text-nq-muted last:mr-0"
                  >
                    {s}
                  </code>
                ))}
              </p>
            ) : (
              <p className="mt-2 text-nq-muted">No salons found in DB.</p>
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}
