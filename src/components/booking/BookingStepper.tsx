import type { BookingMessages } from "@/shared/i18n/booking/en";
import { cn } from "@/shared/lib/cn";

export type BookingWizardStep = "service" | "time" | "confirm";

export function BookingStepper({
  activeStep,
  t,
}: {
  activeStep: BookingWizardStep;
  t: BookingMessages;
}) {
  const steps: { id: BookingWizardStep; label: string }[] = [
    { id: "service", label: t.breadcrumbServices },
    { id: "time", label: t.breadcrumbTime },
    { id: "confirm", label: t.breadcrumbConfirm },
  ];
  const activeIdx = steps.findIndex((s) => s.id === activeStep);

  return (
    <nav aria-label="Booking steps" className="mb-8 lg:mb-10">
      <ol className="flex flex-wrap items-center gap-y-3 text-[13px] font-medium sm:text-sm lg:text-[15px]">
        {steps.map((s, i) => {
          const state =
            i < activeIdx ? "complete" : i === activeIdx ? "current" : "upcoming";

          return (
            <li key={s.id} className="flex items-center">
              {i > 0 ? (
                <span
                  className="mx-3 inline text-nq-muted/35 select-none lg:mx-5"
                  aria-hidden
                >
                  /
                </span>
              ) : null}
              <span
                className={cn(
                  "inline-flex items-center gap-2 rounded-full border px-3 py-2 lg:gap-2.5 lg:px-5 lg:py-2.5",
                  state === "current" &&
                    "border-nq-primary/40 bg-nq-primary/[0.09] text-nq-primary shadow-[0_0_28px_-10px_rgba(212,175,55,0.45)]",
                  state === "complete" &&
                    "border-white/[0.08] text-nq-foreground",
                  state === "upcoming" && "border-transparent text-nq-muted/50",
                )}
              >
                <span
                  className={cn(
                    "flex h-7 min-w-[1.75rem] items-center justify-center rounded-full text-[11px] font-semibold tabular-nums lg:h-8 lg:min-w-[2rem] lg:text-xs",
                    state === "current" && "bg-nq-primary text-nq-bg",
                    state === "complete" &&
                      "border border-white/[0.1] bg-white/[0.06] text-nq-primary",
                    state === "upcoming" && "bg-white/[0.04] text-nq-muted",
                  )}
                  aria-hidden
                >
                  {state === "complete" ? (
                    <svg
                      className="h-3.5 w-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    i + 1
                  )}
                </span>
                <span
                  className={cn(
                    state === "current" && "font-semibold text-nq-foreground",
                    state !== "current" && "text-nq-muted",
                  )}
                >
                  {s.label}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
