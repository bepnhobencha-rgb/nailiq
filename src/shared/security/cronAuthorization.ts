import { NextResponse } from "next/server";

type CronAuthorizationError =
  | "cron_secret_not_configured"
  | "unauthorized";

/**
 * Central fail-closed boundary for every scheduled HTTP entry point.
 *
 * A missing server secret is a deployment fault (503), never permission to run.
 * The full Authorization value must match exactly so alternate schemes and
 * malformed Bearer values cannot be normalized into valid credentials.
 */
export function requireCronAuthorization(
  request: Request,
  configuredSecret = process.env.CRON_SECRET,
): NextResponse | null {
  const expectedSecret = (configuredSecret ?? "").trim();
  let error: CronAuthorizationError;
  let status: 401 | 503;

  if (!expectedSecret) {
    error = "cron_secret_not_configured";
    status = 503;
  } else if (
    request.headers.get("authorization") !== `Bearer ${expectedSecret}`
  ) {
    error = "unauthorized";
    status = 401;
  } else {
    return null;
  }

  return NextResponse.json({ ok: false, error }, { status });
}
