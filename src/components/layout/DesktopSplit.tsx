import { type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

export type DesktopSplitProps = HTMLAttributes<HTMLDivElement> & {
  /** Logo, headline, intro — first on mobile, top of left column on desktop. */
  head: ReactNode;
  /** CTA, forms, and rest — after phone on mobile, continues left column on desktop. */
  rest: ReactNode;
  /** Phone preview: after hero on mobile, right column on desktop. */
  aside: ReactNode;
};

/**
 * Two-column layout from `lg`. Below that: `head` → `aside` → `rest` (phone between hero and
 * CTA) so the device preview can sit in the first viewport. No horizontal scroll.
 */
export function DesktopSplit({
  className,
  head,
  rest,
  aside,
  ...props
}: DesktopSplitProps) {
  return (
    <div
      className={cn(
        "mx-auto grid w-full min-w-0 max-w-[var(--max-nq-mobile)] grid-cols-1",
        "gap-y-3 sm:gap-y-4",
        "lg:max-w-[var(--max-nq-desktop)] lg:grid-cols-2 lg:items-center lg:gap-x-12 lg:gap-y-8 xl:gap-x-16",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "order-1 min-w-0",
          "lg:col-start-1 lg:row-start-1 lg:max-w-xl lg:shrink lg:place-self-stretch xl:max-w-2xl",
        )}
      >
        {head}
      </div>
      <div
        className={cn(
          "order-2 flex min-w-0 flex-col items-center justify-center",
          "lg:col-start-2 lg:row-start-1 lg:row-end-3 lg:shrink-0 lg:justify-center lg:place-self-center",
        )}
      >
        {aside}
      </div>
      <div
        className={cn(
          "order-3 min-w-0",
          "lg:col-start-1 lg:row-start-2 lg:max-w-xl lg:shrink lg:place-self-stretch xl:max-w-2xl",
        )}
      >
        {rest}
      </div>
    </div>
  );
}
