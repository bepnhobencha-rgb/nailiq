"use client";

import * as Sentry from "@sentry/nextjs";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

/**
 * Class-based error boundary for the Receptionist Center surface.
 *
 * Why a class component: React error boundaries are still class-only
 * (no hook equivalent). We keep this minimal and isolated so the rest
 * of the app stays on function components per CLAUDE.md conventions.
 *
 * On error: report to Sentry with `nailiq.surface = "receptionist_center"`
 * tag (matches the proxy's existing tagging convention) and render a
 * friendly retry card. Retry simply forces a remount by bumping a key.
 *
 * Reuses Card + Button primitives per ARCHITECTURE_LOCK §2.
 */

export type ReceptionistErrorBoundaryLabels = {
  title: string;
  message: string;
  retryButton: string;
};

export interface ReceptionistErrorBoundaryProps {
  children: ReactNode;
  /** Localized fallback copy. Parent must supply — error UI is i18n-aware. */
  labels: ReceptionistErrorBoundaryLabels;
  /** Optional context for Sentry tags (e.g. salon slug). */
  salonSlug?: string;
}

interface State {
  hasError: boolean;
  /** True when the error was caused by a session expiry redirect (non-JSON server response). */
  isSessionExpired: boolean;
  /** Increments on retry to remount children. */
  retryNonce: number;
}

export class ReceptionistErrorBoundary extends Component<
  ReceptionistErrorBoundaryProps,
  State
> {
  state: State = { hasError: false, isSessionExpired: false, retryNonce: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    // "An unexpected response was received from the server." is the Next.js
    // error thrown when a Server Action returns an HTML redirect (e.g. to
    // /login) instead of the expected JSON. This always means the session
    // expired — redirect straight to login so staff aren't shown a confusing
    // "Retry" card.
    const isSessionExpired =
      error.message?.includes("unexpected response") ||
      error.message?.includes("NEXT_REDIRECT");
    if (isSessionExpired && typeof window !== "undefined") {
      window.location.href = "/login";
    }
    return { hasError: true, isSessionExpired };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Don't log session-expiry redirects to Sentry — they're expected behaviour,
    // not bugs. The 420+ occurrences in error_logs were all session expirations.
    if (
      error.message?.includes("unexpected response") ||
      error.message?.includes("NEXT_REDIRECT")
    ) {
      return;
    }
    Sentry.captureException(error, {
      tags: {
        "nailiq.surface": "receptionist_center",
        "nailiq.event": "error_boundary",
        ...(this.props.salonSlug
          ? { "salon.slug": this.props.salonSlug }
          : {}),
      },
      extra: {
        componentStack: info.componentStack,
      },
    });
  }

  private handleRetry = () => {
    this.setState((prev) => ({
      hasError: false,
      retryNonce: prev.retryNonce + 1,
    }));
  };

  render(): ReactNode {
    if (this.state.hasError) {
      // Session expired → window.location.href = "/login" already fired in
      // getDerivedStateFromError. Render a blank screen while the redirect
      // completes so staff don't see the error UI flash.
      if (this.state.isSessionExpired) {
        return null;
      }
      const { labels } = this.props;
      return (
        <div className="mx-auto flex min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] items-center justify-center px-4 py-10">
          <Card variant="elevated" padding="lg">
            <div className="space-y-3 text-center">
              <h1
                className="text-lg font-semibold text-nq-foreground"
                data-testid="receptionist-error-boundary-title"
              >
                {labels.title}
              </h1>
              <p className="text-sm text-nq-muted">{labels.message}</p>
              <div className="pt-2">
                <Button
                  type="button"
                  variant="primary"
                  data-testid="receptionist-error-boundary-retry"
                  onClick={this.handleRetry}
                >
                  {labels.retryButton}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      );
    }

    // Bumping the key on retry forces children to remount — anything
    // memoizing transient state inside ReceptionistCenter starts fresh.
    return (
      <div key={this.state.retryNonce} className="contents">
        {this.props.children}
      </div>
    );
  }
}
