import type { BookingMessages } from "@/shared/i18n/booking/en";

export function SalonBookingPaused({
  shopLabel,
  t,
}: {
  shopLabel: string;
  t: BookingMessages;
}) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-4 py-16 pb-safe">
      <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
        {t.salonNotLiveHeading}
      </h1>
      <p className="mt-3 text-base leading-relaxed text-nq-muted">
        {t.salonNotLiveBody.replace("{shop}", shopLabel)}
      </p>
    </div>
  );
}
