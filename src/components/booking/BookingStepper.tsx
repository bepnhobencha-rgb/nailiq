import type { BookingMessages } from "@/shared/i18n/booking/en";
import { cn } from "@/shared/lib/cn";

export type BookingWizardStep =
  | "service"
  | "staff"
  | "date"
  | "time"
  | "info"
  | "confirm";

const STEP_ORDER: BookingWizardStep[] = [
  "service",
  "staff",
  "date",
  "time",
  "info",
  "confirm",
];

export function BookingStepper({
  activeStep,
  t,
}: {
  activeStep: BookingWizardStep;
  t: BookingMessages;
}) {
  const labels: Record<BookingWizardStep, string> = {
    service: t.breadcrumbServices,
    staff: t.breadcrumbStaff,
    date: t.breadcrumbDate,
    time: t.breadcrumbTime,
    info: t.breadcrumbYourDetails,
    confirm: t.breadcrumbConfirm,
  };

  const activeIdx = STEP_ORDER.indexOf(activeStep);

  return (
    <nav aria-label="Booking steps" className="mb-8 lg:mb-10">
      <ol className="flex w-full items-start gap-0">
        {STEP_ORDER.map((id, i) => {
          const state =
            i < activeIdx ? "done" : i === activeIdx ? "current" : "upcoming";

          return (
            <li key={id} className="flex min-w-0 flex-1 items-start">
              {i > 0 ? (
                <div
                  className="mt-[0.42rem] h-px min-w-[6px] flex-1 bg-white/[0.12] sm:mt-[0.48rem]"
                  aria-hidden
                />
              ) : null}
              <div className="flex min-w-0 flex-1 flex-col items-center gap-1 text-center">
                <span
                  className={cn(
                    "flex h-2.5 w-2.5 shrink-0 rounded-full border border-transparent sm:h-3 sm:w-3",
                    state === "done" && "bg-nq-muted/85",
                    state === "current" &&
                      "border-nq-primary bg-nq-primary shadow-[0_0_18px_-4px_rgba(212,175,55,0.55)]",
                    state === "upcoming" &&
                      "border-white/[0.22] bg-transparent",
                  )}
                  aria-hidden
                />
                <span
                  className={cn(
                    "w-full text-[10px] leading-tight tracking-tight sm:line-clamp-2 sm:text-[11px] lg:text-xs",
                    state === "current"
                      ? "font-semibold text-nq-foreground"
                      : "text-nq-muted/75",
                    // Below sm: only render the label for the current step so
                    // long labels (e.g. "Your details") don't wrap and shove
                    // the row onto two lines on narrow viewports.
                    state === "current" ? "block" : "hidden sm:block",
                  )}
                >
                  {labels[id]}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
