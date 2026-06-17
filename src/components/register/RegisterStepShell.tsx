"use client";

import { type ReactNode, useMemo } from "react";
import Link from "next/link";
import { MobileStack } from "@/components/layout/MobileStack";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
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
};

/**
 * Onboarding step wrapper: home ambient, iPhone-tight width, no dashboard chrome.
 */
export function RegisterStepShell({
  title,
  subtext,
  helperHint,
  step,
  children,
}: RegisterStepShellProps) {
  const { language } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language).auth, [language]);

  return (
    <ResponsiveShell>
      <MobileStack className="w-full max-w-[var(--max-nq-mobile)] sm:pt-2">
        <div className="w-full min-w-0">
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
            <p className="mt-2 text-pretty text-base text-nq-muted">
              {subtext}
            </p>
          ) : null}
          {helperHint ? (
            <p className="mt-1.5 text-xs leading-relaxed text-nq-muted/80">
              {helperHint}
            </p>
          ) : null}
          <div className="mt-8 min-w-0 sm:mt-10">{children}</div>
        </div>
      </MobileStack>
    </ResponsiveShell>
  );
}
