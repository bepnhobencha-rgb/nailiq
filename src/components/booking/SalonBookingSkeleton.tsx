import type { HTMLAttributes } from "react";
import { cn } from "@/shared/lib/cn";

function ShimmerBlock({
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-2xl bg-nq-surface/80",
        "bg-[linear-gradient(100deg,rgba(161,161,170,0)_0%,rgba(161,161,170,0.12)_45%,rgba(161,161,170,0)_90%)]",
        "[background-size:200%_100%]",
        "[animation:shimmer_2.4s_ease-in-out_infinite]",
        className,
      )}
      {...rest}
    />
  );
}

/** Loading shell for `/[slug]` public booking — dark theme + light shimmer; mirrors split layout. Wrap with `BookingDocumentEn` in Suspense fallback when needed. */
export function SalonBookingSkeleton() {
  return (
    <div className="relative min-h-dvh">
      <main className="relative z-10 mx-auto w-full max-w-[1200px] px-4 py-10 pb-safe sm:px-6 lg:flex lg:items-start lg:gap-10 lg:px-8 lg:py-14">
        <div className="mx-auto w-full max-w-[min(100%,420px)] shrink-0 lg:mx-0 lg:sticky lg:top-10">
          <ShimmerBlock className="h-40 w-full sm:h-48" />
          <div className="mt-4 space-y-2">
            <ShimmerBlock className="h-4 w-3/4 max-w-[14rem]" />
            <ShimmerBlock className="h-3 w-1/2 max-w-[10rem]" />
          </div>
        </div>
        <div className="mt-10 min-w-0 flex-1 space-y-5 lg:mt-0 lg:max-w-[min(100%,740px)] lg:pt-1">
          <div className="space-y-3">
            <ShimmerBlock className="h-8 w-4/5 max-w-md" />
            <ShimmerBlock className="h-4 w-full max-w-lg" />
          </div>
          <ShimmerBlock className="h-32 w-full rounded-3xl" />
          <div className="grid gap-3 sm:grid-cols-2">
            <ShimmerBlock className="h-24 rounded-2xl" />
            <ShimmerBlock className="h-24 rounded-2xl" />
          </div>
          <ShimmerBlock className="h-14 w-full max-w-xs rounded-full" />
        </div>
      </main>
    </div>
  );
}
