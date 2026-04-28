import { type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

export type MobileStackProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  /**
   * Optional fixed bottom area (e.g. future primary CTA bar). Renders in a safe-area
   * inset layer; set `withStickyReserve` to add scroll padding so content is not
   * obscured.
   */
  stickyCta?: ReactNode;
  /** Add bottom padding when `stickyCta` is used so the last content stays visible. */
  withStickyReserve?: boolean;
};

/**
 * Single column, iPhone-tight max width, safe-area bottom, no horizontal overflow.
 * On `lg+`, mobile max width lifts slightly for readability on larger phones.
 */
export function MobileStack({
  className,
  children,
  stickyCta,
  withStickyReserve = true,
  ...props
}: MobileStackProps) {
  return (
    <>
      <div
        className={cn(
          "mx-auto flex w-full min-w-0 max-w-[var(--max-nq-mobile)] flex-col",
          "lg:mx-0 lg:max-w-none",
          "pb-safe",
          stickyCta && withStickyReserve && "pb-safe-cta",
          className,
        )}
        {...props}
      >
        {children}
      </div>
      {stickyCta != null ? (
        <div
          className="fixed right-0 bottom-0 left-0 z-30 min-h-[3.5rem] px-4 pt-2"
          style={{
            paddingBottom: "max(0.75rem, env(safe-area-inset-bottom, 0px))",
          }}
        >
          <div className="mx-auto w-full max-w-[var(--max-nq-mobile)] min-w-0">
            {stickyCta}
          </div>
        </div>
      ) : null}
    </>
  );
}
