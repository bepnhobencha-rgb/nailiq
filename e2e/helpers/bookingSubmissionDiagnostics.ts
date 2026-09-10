import type { Page, Request, Response, TestInfo } from "@playwright/test";

const SUBMISSION_PATHS = new Set([
  "/api/booking/verify-decision",
  "/api/booking/quote",
  "/api/booking/wix-conflict",
  "/rest/v1/rpc/create_public_booking",
  "/api/booking/card-capability",
  "/api/booking/wix-create",
  "/api/booking/sms-confirm",
]);

/** Passive, public-safe evidence; never retry a booking or change its assertions. */
export async function withBookingSubmissionDiagnostics(
  page: Page,
  info: TestInfo,
  run: () => Promise<void>,
): Promise<void> {
  const started = Date.now();
  const events: Array<Record<string, unknown>> = [];
  const record = (event: Record<string, unknown>) => {
    events.push({ elapsedMs: Date.now() - started, ...event });
  };
  const requestPath = (request: Request): string | null => {
    const path = new URL(request.url()).pathname;
    return SUBMISSION_PATHS.has(path) ? path : null;
  };
  const onRequest = (request: Request) => {
    const path = requestPath(request);
    if (path) record({ kind: "request", path, method: request.method() });
  };
  const onResponse = (response: Response) => {
    const path = requestPath(response.request());
    if (path) record({ kind: "response", path, status: response.status() });
  };
  const onFailure = (request: Request) => {
    const path = requestPath(request);
    if (path) record({ kind: "request-failed", path });
  };
  // Raw messages, URLs, headers, payloads and booking/customer IDs are excluded.
  const onPageError = () => record({ kind: "pageerror" });
  const onCrash = () => record({ kind: "page-crash" });
  const onClose = () => record({ kind: "page-close" });
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onFailure);
  page.on("pageerror", onPageError);
  page.on("crash", onCrash);
  page.on("close", onClose);
  let failed = false;
  try {
    await run();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // A stalled WebKit renderer must not prevent fixture cleanup or replace
    // the original assertion failure. This deadline bounds diagnostics only.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const browserState = await Promise.race([
        page.evaluate(async () => {
          const button = document.querySelector<HTMLButtonElement>(
            '[data-testid="confirm-booking-btn"]',
          );
          const state = {
            successMounted: Boolean(document.querySelector('[data-testid="booking-success"]')),
            confirmMounted: Boolean(button),
            confirmDisabled: button?.disabled ?? null,
            visibility: document.visibilityState,
            secureContext: isSecureContext,
            webLocksAvailable: Boolean(navigator.locks),
          };
          const locks = navigator.locks ? await navigator.locks.query() : null;
          const isBookingLock = (lock: LockInfo) =>
            lock.name?.startsWith("nailiq:public-booking-request:") === true;
          return {
            ...state,
            heldBookingLocks: locks?.held?.filter(isBookingLock).length ?? null,
            pendingBookingLocks: locks?.pending?.filter(isBookingLock).length ?? null,
          };
        }).catch(() => ({ unavailable: true })),
        new Promise<{ timedOut: true }>((resolve) => {
          timer = setTimeout(() => resolve({ timedOut: true }), 2_000);
        }),
      ]);
      await info.attach("booking-submission-diagnostics", {
        body: JSON.stringify({ failed, events, browserState }),
        contentType: "application/json",
      });
    } catch {
      // Diagnostics are supplemental; the test and cleanup retain authority.
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onFailure);
      page.off("pageerror", onPageError);
      page.off("crash", onCrash);
      page.off("close", onClose);
    }
  }
}
