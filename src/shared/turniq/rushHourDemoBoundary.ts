import {
  isDemoSlugPinBypassed,
  type DemoOtpEnvironment,
} from "@/shared/lib/demoOtpMode";

const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;
const VERCEL_PREVIEW_HOST_RE = /\.vercel\.app$/i;
const PRODUCTION_HOST_RE = /(^|\.)nailiq\.(ca|vercel\.app)$/i;

/**
 * The rush-hour board contains only checked-in deterministic fixtures and
 * never reads a tenant or provider. It is available on Vercel Preview so every
 * PR can prove the UX without copying QA secrets to a new branch. Loopback
 * access retains the stricter shared E2E boundary. Production runtime and
 * production hosts always fail closed.
 */
export function isTurnIqRushHourDemoAllowed(
  host: string,
  env: DemoOtpEnvironment = process.env,
): boolean {
  const normalizedHost = host.trim().toLowerCase();
  const vercelEnv = env.VERCEL_ENV?.trim().toLowerCase();
  if (vercelEnv === "production" || PRODUCTION_HOST_RE.test(normalizedHost)) {
    return false;
  }
  if (vercelEnv === "preview" && VERCEL_PREVIEW_HOST_RE.test(normalizedHost)) {
    return true;
  }
  return LOOPBACK_HOST_RE.test(normalizedHost) && isDemoSlugPinBypassed(env);
}
