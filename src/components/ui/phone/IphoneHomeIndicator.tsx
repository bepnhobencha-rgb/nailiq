import { cn } from "@/shared/lib/cn";

type IphoneHomeIndicatorProps = {
  className?: string;
};

/**
 * iOS-style home indicator pill (decorative, marketing phone mock).
 */
export function IphoneHomeIndicator({ className }: IphoneHomeIndicatorProps) {
  return (
    <div
      className={cn("flex w-full justify-center px-2 pb-0.5 pt-1", className)}
      aria-hidden
    >
      <div className="h-[4px] w-[3.2rem] rounded-full bg-nq-foreground/18" />
    </div>
  );
}
