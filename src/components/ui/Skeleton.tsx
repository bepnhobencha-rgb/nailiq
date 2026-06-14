import { cn } from "@/shared/lib/cn";

/**
 * Shared loading skeleton primitive. A single pulsing block; compose
 * several to mirror the real content's shape. Use `rounded` to override
 * the default 2xl radius (e.g. `rounded-full` for an avatar). Replaces the
 * per-page ad-hoc `animate-pulse` divs scattered across the dashboard.
 */
export function Skeleton({
  className,
  rounded = "rounded-2xl",
}: {
  className?: string;
  rounded?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "animate-pulse border border-nq-border/40 bg-nq-surface/40",
        rounded,
        className,
      )}
    />
  );
}

/**
 * Convenience: a grid of card-shaped skeletons for list/grid pages.
 */
export function SkeletonCardGrid({
  count = 6,
  className,
  cardClassName = "h-28",
}: {
  count?: number;
  className?: string;
  cardClassName?: string;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      className={cn(
        "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3",
        className,
      )}
    >
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className={cardClassName} />
      ))}
    </div>
  );
}
