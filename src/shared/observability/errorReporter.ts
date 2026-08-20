import {
  redactObservabilityContext,
  redactSensitiveText,
} from "@/shared/observability/privacy";

type CaptureOptions = {
  level?: "fatal" | "error" | "warning" | "info";
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
};

type InternalError = {
  message: string;
  stack: string | null;
  level: "fatal" | "error" | "warning";
  surface: string;
  route: string | null;
  context: Record<string, unknown>;
};

const HANDLER = Symbol.for("nailiq.internal-error-handler");
type ReporterGlobal = typeof globalThis & {
  [HANDLER]?: (error: InternalError) => void;
};

function normalizeLevel(level: CaptureOptions["level"]): InternalError["level"] {
  if (level === "fatal" || level === "warning") return level;
  if (level === "info") return "warning";
  return "error";
}

function emit(
  message: string,
  stack: string | null,
  options: CaptureOptions = {},
) {
  const route =
    typeof location !== "undefined"
      ? redactSensitiveText(location.pathname)
      : null;
  const event: InternalError = {
    message: redactSensitiveText(message).slice(0, 2000),
    stack: stack ? redactSensitiveText(stack).slice(0, 8000) : null,
    level: normalizeLevel(options.level),
    surface: typeof window === "undefined" ? "server" : "client",
    route,
    context: redactObservabilityContext({
      tags: options.tags,
      extra: options.extra,
      contexts: options.contexts,
    }),
  };

  const handler = (globalThis as ReporterGlobal)[HANDLER];
  if (handler) {
    handler(event);
    return;
  }

  if (typeof window !== "undefined") {
    const body = JSON.stringify(event);
    try {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon?.("/api/errors", blob)) return;
      void fetch("/api/errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      });
    } catch {
      // The reporter must never break the customer flow.
    }
    return;
  }

  console.error("[NailIQ Error Monitor]", event.message, event.context);
}

export function installInternalErrorHandler(
  handler: (error: InternalError) => void,
) {
  (globalThis as ReporterGlobal)[HANDLER] = handler;
}

export function captureException(error: unknown, options: CaptureOptions = {}) {
  const normalized = error instanceof Error ? error : new Error(String(error));
  emit(normalized.message, normalized.stack ?? null, options);
}

export function captureMessage(message: string, options: CaptureOptions = {}) {
  emit(message, null, options);
}

export function captureEvent(event: {
  message?: string;
  level?: CaptureOptions["level"];
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
}) {
  emit(event.message ?? "Captured event", null, event);
}

export function startSpan<T>(
  _options: Record<string, unknown>,
  callback: () => T,
): T {
  return callback();
}

const inertScope = {
  setTag: (_key: string, _value: unknown) => inertScope,
  setContext: (_key: string, _value: unknown) => inertScope,
};

/** Compatibility for old request-local tags; explicit capture metadata is preferred. */
export function getCurrentScope() {
  return inertScope;
}
