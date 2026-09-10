"use client";

import * as ErrorReporter from "@/shared/observability/errorReporter";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import type { BookingSalonMeta } from "@/shared/booking/loadBookingServices";
import type { BookingMessages } from "@/shared/i18n/booking";

type Props = {
  shopSlug: string;
  salon: BookingSalonMeta;
  messages: BookingMessages["errorBoundary"];
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

    const { messages } = this.props;
    // A render failure carries no proof of whether a booking committed.
    // Keep this recovery message neutral, including after confirmation.
    return (
      <div
        className="mt-8 w-full rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-6 text-center"
        role="alert"
      >
        <p className="font-medium tracking-tight text-[var(--booking-text)]">
          {messages.title}
        </p>
        <p className="mt-2 text-base leading-relaxed text-[var(--booking-text-muted)]">
          {messages.detail}
        </p>
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="mx-auto mt-5 h-auto min-h-12 max-w-full whitespace-normal border-[var(--booking-border)] bg-[var(--booking-bg-input)] py-3 text-[var(--booking-text)] hover:bg-[var(--booking-bg-card)]"
          onClick={this.resetError}
        >
          {messages.retry}
        </Button>
      </div>
    );
  }
}
