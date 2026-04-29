"use client";

import * as Sentry from "@sentry/nextjs";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import type { BookingSalonMeta } from "@/shared/booking/loadBookingServices";

export function BookingFlowErrorBoundary(props: {
  shopSlug: string;
  salon: BookingSalonMeta;
  children: ReactNode;
}) {
  const { shopSlug, salon, children } = props;

  return (
    <Sentry.ErrorBoundary
      beforeCapture={(scope) => {
        scope.setTag("booking.flow", "public_ui");
        scope.setTag("salon.id", salon.id);
        scope.setTag("salon.slug", shopSlug);
        scope.setContext("salon", {
          id: salon.id,
          slug: shopSlug,
          name: salon.name ?? "",
        });
      }}
      fallback={({ resetError }) => (
        <div
          className="glass mt-8 w-full rounded-2xl border border-nq-border/50 p-6 text-center"
          role="alert"
        >
          <p className="font-medium tracking-tight text-nq-foreground">
            Something went wrong while loading booking.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-nq-muted">
            Please refresh the page or come back shortly. Your selection was not
            confirmed.
          </p>
          <Button
            type="button"
            variant="secondary"
            size="md"
            className="mx-auto mt-5"
            onClick={resetError}
          >
            Try again
          </Button>
        </div>
      )}
    >
      {children}
    </Sentry.ErrorBoundary>
  );
}
