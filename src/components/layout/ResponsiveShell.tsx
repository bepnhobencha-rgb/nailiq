import { type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

export type ResponsiveShellProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  /** Hero ambient wash (top gold) */
  showAmbient?: boolean;
};

/**
 * App-wide responsive container: min viewport height, horizontal clip, section padding
 * from theme vars, vertical centering for marketing hero. Mobile-first; pairs with
 * `MobileStack` + `DesktopSplit` on the home foundation preview.
 */
export function ResponsiveShell({
  className,
  children,
  showAmbient = true,
  ...props
}: ResponsiveShellProps) {
  return (
    <div
      className={cn(
        "relative flex min-h-dvh min-w-0 flex-1 flex-col overflow-x-clip",
        className,
      )}
      {...props}
    >
      {showAmbient ? (
        <div className="pointer-events-none fixed inset-0 -z-10 overflow-x-clip">
          <div
            className="absolute top-[-100px] left-1/2 h-[400px] w-[min(100vw,28rem)] max-w-full -translate-x-1/2 rounded-full bg-nq-primary/10 blur-[120px]"
            aria-hidden
          />
        </div>
      ) : null}
      <div
        className={cn(
          "relative z-0 mx-auto flex w-full min-w-0 max-w-[var(--max-nq-desktop)] flex-1 flex-col items-stretch justify-start",
          "px-[var(--pad-nq-section-mobile)] py-6",
          "sm:py-8",
          "md:px-6 md:py-10",
          "lg:justify-center lg:px-[var(--pad-nq-section-desktop)] lg:py-12 lg:pb-16",
        )}
      >
        {children}
      </div>
    </div>
  );
}
