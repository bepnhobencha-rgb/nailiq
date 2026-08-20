"use client";

import * as ErrorReporter from "@/shared/observability/errorReporter";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import type { BookingSalonMeta } from "@/shared/booking/loadBookingServices";

type Props = {
  shopSlug: string;
  salon: BookingSalonMeta;
  children: ReactNode;
};

type State = { error: Error | null };

export class BookingFlowErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    ErrorReporter.captureException(error, {
      tags: {
        "booking.flow": "public_ui",
        "salon.id": this.props.salon.id,
        "salon.slug": this.props.shopSlug,
      },
      extra: { componentStack: info.componentStack },
    });
  }

  private resetError = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;

    return (
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
            onClick={this.resetError}
          >
            Try again
          </Button>
      </div>
    );
  }
}
