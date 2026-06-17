"use client";

import { type ReactNode, useMemo } from "react";
import Link from "next/link";
import { cn } from "@/shared/lib/cn";
import { AuthLanguageToggle } from "@/components/auth/AuthLanguageToggle";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type RegisterStepShellProps = {
  title: string;
  children?: ReactNode;
  /** Muted one-liner under the title */
  subtext?: string;
  /** Smaller, dev-only hint rendered under the subtext (gated by caller). */
  helperHint?: string;
  /** Step progress indicator — shown as dots + "Bước X / Y" */
  step?: { current: number; total: number };
  /** Show brand panel on the left on desktop (login + register entry pages only). */
  showBrandPanel?: boolean;
};

/**
 * Onboarding step wrapper.
 *
 * When `showBrandPanel` is true (login / register entry): desktop shows a
 * two-column layout — brand panel on the left, form on the right.
 * Mobile is always single-column.
 *
 * When `showBrandPanel` is false (default): single centered column at all
 * breakpoints (used by setup wizard, success, verify pages).
 */
export function RegisterStepShell({
  title,
  subtext,
  helperHint,
  step,
  showBrandPanel = false,
  children,
}: RegisterStepShellProps) {
  const { language } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language).auth, [language]);

  const formContent = (
    <div
      className={cn(
        "w-full min-w-0",
        !showBrandPanel && "mx-auto",
        "max-w-[var(--max-nq-mobile)]",
      )}
    >
      {/* Back link + language toggle */}
      <div className="flex items-center justify-between gap-4">
        <Link
          href="/"
          className="text-sm text-nq-muted transition-colors duration-200 hover:text-nq-foreground/90"
        >
          {t.backHome}
        </Link>
        <AuthLanguageToggle />
      </div>

      {/* Step progress dots */}
      {step ? (
        <div className="mt-6 flex items-center gap-2">
          {Array.from({ length: step.total }, (_, i) => (
            <div
              key={i}
              className={`h-2 rounded-full transition-all ${
                i + 1 < step.current
                  ? "w-4 bg-nq-primary/60"
                  : i + 1 === step.current
                    ? "w-6 bg-nq-primary"
                    : "w-2 bg-nq-border"
              }`}
            />
          ))}
          <span className="ml-1 text-xs text-nq-muted">
            {language === "vi"
              ? `Bước ${step.current} / ${step.total}`
              : `Step ${step.current} of ${step.total}`}
          </span>
        </div>
      ) : null}

      <h1 className="mt-8 text-balance text-2xl font-semibold tracking-tight text-nq-foreground sm:mt-10 sm:text-3xl">
        {title}
      </h1>
      {subtext ? (
        <p className="mt-2 text-pretty text-base text-nq-muted">{subtext}</p>
      ) : null}
      {helperHint ? (
        <p className="mt-1.5 text-xs leading-relaxed text-nq-muted/80">
          {helperHint}
        </p>
      ) : null}
      <div className="mt-8 min-w-0 sm:mt-10">{children}</div>
    </div>
  );

  return (
    <div className="relative flex min-h-dvh flex-col overflow-x-clip lg:flex-row">
      {/* Ambient glow */}
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-x-clip">
        <div
          className={cn(
            "absolute top-[-100px] h-[400px] w-[min(100vw,28rem)] max-w-full rounded-full bg-nq-primary/10 blur-[120px]",
            showBrandPanel
              ? "left-[22%] -translate-x-1/2"
              : "left-1/2 -translate-x-1/2",
          )}
          aria-hidden
        />
      </div>

      {/* Brand panel — desktop only, login + register entry */}
      {showBrandPanel ? (
        <div className="hidden border-r border-nq-border/20 lg:flex lg:w-[44%] lg:shrink-0 lg:flex-col lg:justify-center lg:px-12 xl:w-[480px] xl:px-16">
          <p className="text-2xl font-bold tracking-tight text-nq-primary">
            NailIQ
          </p>
          <p className="mt-3 text-xl font-semibold leading-snug text-nq-foreground">
            {t.brandTagline}
          </p>
          <ul className="mt-8 flex flex-col gap-4">
            {[t.brandBullet1, t.brandBullet2, t.brandBullet3].map((b, i) => (
              <li key={i} className="flex items-start gap-3 text-base text-nq-muted">
                <span className="mt-0.5 shrink-0 text-lg leading-none text-nq-primary">
                  ✓
                </span>
                {b}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Form column */}
      <div
        className={cn(
          "flex flex-1 flex-col justify-start",
          "px-[var(--pad-nq-section-mobile)] py-4",
          "sm:py-8",
          "md:px-6 md:py-10",
          showBrandPanel
            ? "lg:items-center lg:justify-center lg:px-10 lg:py-12"
            : "lg:items-center lg:justify-center lg:px-[var(--pad-nq-section-desktop)] lg:py-12 lg:pb-16",
        )}
      >
        {formContent}
      </div>
    </div>
  );
}
