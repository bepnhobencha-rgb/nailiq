"use client";

import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import {
  getBookingCatalog,
  getServiceById,
} from "@/shared/booking/catalog";
import { submitPublicBooking } from "@/shared/booking/submitPublicBooking";
import type { BookingMessages } from "@/shared/i18n/booking/en";

type Step = "service" | "time" | "confirm" | "done";

type BookingFlowProps = {
  t: BookingMessages;
  shopSlug: string;
};

function decodeShop(shop: string) {
  try {
    return decodeURIComponent(shop);
  } catch {
    return shop;
  }
}

export function BookingFlow({ t, shopSlug }: BookingFlowProps) {
  const shopLabel = useMemo(() => decodeShop(shopSlug), [shopSlug]);
  const { services, timeSlots } = useMemo(
    () => getBookingCatalog(shopSlug),
    [shopSlug],
  );

  const [step, setStep] = useState<Step>("service");
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [timeSlot, setTimeSlot] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const service = serviceId
    ? getServiceById(services, serviceId)
    : undefined;

  const goServiceNext = useCallback(() => {
    if (!serviceId) {
      return;
    }
    setStep("time");
  }, [serviceId]);

  const goTimeNext = useCallback(() => {
    if (!timeSlot) {
      return;
    }
    setStep("confirm");
  }, [timeSlot]);

  const onConfirm = useCallback(async () => {
    if (!serviceId || !timeSlot) {
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await submitPublicBooking({ shopSlug, serviceId, timeSlot });
      setStep("done");
    } catch {
      setError(t.submitError);
    } finally {
      setSubmitting(false);
    }
  }, [serviceId, timeSlot, shopSlug, t.submitError]);

  if (step === "done") {
    return (
      <Card>
        <p className="text-nq-foreground" role="status">
          {t.successMessage}
        </p>
        <ul className="mt-3 list-inside list-disc text-sm text-nq-muted">
          <li>
            {t.summaryShop}: {shopLabel}
          </li>
          {service ? (
            <li>
              {t.summaryService}: {service.name}
            </li>
          ) : null}
          {timeSlot ? (
            <li>
              {t.summaryTime}: {timeSlot}
            </li>
          ) : null}
        </ul>
      </Card>
    );
  }

  return (
    <div className="mt-6 space-y-6">
      {step === "service" && (
        <section aria-labelledby="svc-heading">
          <h2
            id="svc-heading"
            className="text-base font-medium text-nq-foreground"
          >
            {t.stepServiceHeading}
          </h2>
          <fieldset className="mt-3 space-y-2">
            <legend className="sr-only">{t.stepServiceHeading}</legend>
            {services.map((s) => (
              <label
                key={s.id}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-nq-border px-3 py-2 text-nq-foreground has-[:checked]:border-nq-primary/60"
              >
                <input
                  type="radio"
                  name="service"
                  value={s.id}
                  className="text-nq-primary"
                  checked={serviceId === s.id}
                  onChange={() => {
                    setServiceId(s.id);
                  }}
                />
                <span>{s.name}</span>
              </label>
            ))}
          </fieldset>
          <div className="mt-4">
            <Button
              type="button"
              className="w-full"
              size="lg"
              disabled={!serviceId}
              onClick={goServiceNext}
            >
              {t.next}
            </Button>
          </div>
        </section>
      )}

      {step === "time" && (
        <section aria-labelledby="time-heading">
          <h2
            id="time-heading"
            className="text-base font-medium text-nq-foreground"
          >
            {t.stepTimeHeading}
          </h2>
          <fieldset className="mt-3 space-y-2">
            <legend className="sr-only">{t.stepTimeHeading}</legend>
            {timeSlots.map((slot) => (
              <label
                key={slot}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-nq-border px-3 py-2 text-nq-foreground has-[:checked]:border-nq-primary/60"
              >
                <input
                  type="radio"
                  name="time"
                  value={slot}
                  className="text-nq-primary"
                  checked={timeSlot === slot}
                  onChange={() => {
                    setTimeSlot(slot);
                  }}
                />
                <span>{slot}</span>
              </label>
            ))}
          </fieldset>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:gap-3">
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              onClick={() => {
                setStep("service");
              }}
            >
              {t.back}
            </Button>
            <Button
              type="button"
              className="w-full"
              size="lg"
              disabled={!timeSlot}
              onClick={goTimeNext}
            >
              {t.next}
            </Button>
          </div>
        </section>
      )}

      {step === "confirm" && service && timeSlot && (
        <section aria-labelledby="conf-heading">
          <h2
            id="conf-heading"
            className="text-base font-medium text-nq-foreground"
          >
            {t.stepConfirmHeading}
          </h2>
          <dl className="mt-3 space-y-1 text-sm text-nq-muted">
            <div className="flex justify-between gap-4">
              <dt className="text-nq-muted">{t.summaryShop}</dt>
              <dd className="text-right text-nq-foreground">{shopLabel}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-nq-muted">{t.summaryService}</dt>
              <dd className="text-right text-nq-foreground">{service.name}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-nq-muted">{t.summaryTime}</dt>
              <dd className="text-right text-nq-foreground">{timeSlot}</dd>
            </div>
          </dl>
          {error ? (
            <p className="mt-2 text-sm text-nq-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:gap-3">
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              disabled={submitting}
              onClick={() => {
                setStep("time");
                setError(null);
              }}
            >
              {t.back}
            </Button>
            <Button
              type="button"
              className="w-full"
              size="lg"
              disabled={submitting}
              onClick={onConfirm}
            >
              {submitting ? t.submitting : t.confirmBooking}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
