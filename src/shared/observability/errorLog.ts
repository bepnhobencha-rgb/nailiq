import { createHash } from "node:crypto";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Self-hosted error capture (no third-party). Fire-and-forget, service-role,
 * NEVER throws — a logging hiccup must not break the request it's reporting on.
 * Recurrences of the same error are deduped server-side (see `log_error` RPC):
 * the same fingerprint while still `open` bumps a counter instead of inserting.
 *
 * Pairs with Sentry today (dual-write); once the in-house view + alerts are
 * trusted, Sentry can be removed.
 */

export type ErrorLevel = "fatal" | "error" | "warning";

export type LogErrorInput = {
  message: string;
  level?: ErrorLevel;
  /** Where it happened: 'client' | 'server' | 'api' | 'public_booking' | 'dashboard' … */
  surface?: string | null;
  /** Pathname or server-action name. */
  route?: string | null;
  salonId?: string | null;
  userId?: string | null;
  stack?: string | null;
  context?: Record<string, unknown> | null;
};

/**
 * Normalize a message so near-identical errors on the same route share one
 * fingerprint. The route is load-bearing: grouping a React runtime error from
 * `/choose-salon` with the same minified message from `/dashboard/.../center`
 * leaves the row's original route paired with the latest occurrence's context,
 * which sends operators and AI remediation to the wrong component.
 */
function fingerprint(
  level: string,
  surface: string,
  route: string,
  message: string,
): string {
  const norm = message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(/\d+/g, "<n>")
    .trim()
    .slice(0, 300);
  const routeKey = route.trim().slice(0, 300);
  return createHash("sha1")
    .update(`${level}|${surface}|${routeKey}|${norm}`)
    .digest("hex")
    .slice(0, 16);
}

// E2E / test / demo salons hit the same routes (slugs like `e2e-rc-desktop-…`,
// `test-…`, `playwright`), so they'd flood the monitor with non-customer noise.
// Skip capturing anything whose route or href points at a test slug.
const TEST_NOISE_RE = /(?:^|\/)(?:e2e|test|playwright)[-_]/i;
function isTestNoise(input: LogErrorInput): boolean {
  const href = typeof input.context?.href === "string" ? input.context.href : "";
  return TEST_NOISE_RE.test(`${input.route ?? ""} ${href}`);
}

export async function logError(input: LogErrorInput): Promise<void> {
  try {
    if (isTestNoise(input)) return;
    const message = String(input.message ?? "").trim().slice(0, 2000);
    if (!message) return;
    const level: ErrorLevel = input.level ?? "error";
    const surface = (input.surface ?? "").toString().slice(0, 60) || null;
    const route = input.route ? String(input.route).slice(0, 300) : null;
    const fp = fingerprint(level, surface ?? "", route ?? "", message);

    const db = createServiceRoleClient();
    await db.rpc("log_error", {
      p_fingerprint: fp,
      p_level: level,
      p_message: message,
      p_surface: surface,
      p_route: route,
      p_salon_id: input.salonId ?? null,
      p_user_id: input.userId ?? null,
      p_stack: input.stack ? String(input.stack).slice(0, 8000) : null,
      p_context: (input.context ?? {}) as never,
    });
  } catch (e) {
    // Never propagate — this is the reporter, not the feature.
    console.error("[logError] failed to record error", e);
  }
}

/** Convenience for server catch blocks: `captureServerError(e, { surface, route, salonId })`. */
export function captureServerError(
  err: unknown,
  meta: Omit<LogErrorInput, "message" | "stack"> = {},
): void {
  const e = err as { message?: string; stack?: string } | null;
  void logError({
    message: e?.message ? String(e.message) : String(err),
    stack: e?.stack ?? null,
    surface: meta.surface ?? "server",
    ...meta,
  });
}
