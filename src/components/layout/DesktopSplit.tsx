import { type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

export type DesktopSplitProps = HTMLAttributes<HTMLDivElement> & {
  /** Primary column: headline, trust, CTA, form (left on `lg+`). */
  main: ReactNode;
  /** Secondary: preview, device frame (right on `lg+`). */
  aside: ReactNode;
};

/**
 * Two-column layout from `lg`. Below that, stacks `main` then `aside` (preview below form).
 * Max width and gap follow foundation marketing shell.
 */
export function DesktopSplit({
  className,
  main,
  aside,
  ...props
}: DesktopSplitProps) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full min-w-0 max-w-[var(--max-nq-mobile)] flex-col items-stretch gap-10",
        "lg:max-w-[var(--max-nq-desktop)] lg:flex-row lg:items-center lg:justify-between lg:gap-12 xl:gap-16",
        className,
      )}
      {...props}
    >
      <div className="min-w-0 flex-1 lg:min-h-0 lg:max-w-xl lg:shrink lg:basis-1/2 xl:max-w-2xl">
        {main}
      </div>
      <div className="flex min-w-0 flex-col items-center justify-center lg:shrink-0 lg:basis-1/2">
        {aside}
      </div>
    </div>
  );
}
