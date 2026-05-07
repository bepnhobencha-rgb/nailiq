import { type ReactNode } from "react";
import Link from "next/link";
import { MobileStack } from "@/components/layout/MobileStack";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";

type RegisterStepShellProps = {
  title: string;
  children: ReactNode;
  /** Muted one-liner under the title */
  subtext?: string;
  /** Smaller, dev-only hint rendered under the subtext (gated by caller). */
  helperHint?: string;
};

/**
 * Onboarding step wrapper: home ambient, iPhone-tight width, no dashboard chrome.
 */
export function RegisterStepShell({
  title,
  subtext,
  helperHint,
  children,
}: RegisterStepShellProps) {
  return (
    <ResponsiveShell>
      <MobileStack className="w-full max-w-[var(--max-nq-mobile)] sm:pt-2">
        <div className="w-full min-w-0">
          <Link
            href="/"
            className="text-sm text-nq-muted transition-colors duration-200 hover:text-nq-foreground/90"
          >
            ← Home
          </Link>
          <h1 className="mt-8 text-balance text-2xl font-semibold tracking-tight text-nq-foreground sm:mt-10 lg:text-3xl">
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
