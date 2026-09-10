/**
 * Auth cookies default to HTTPS, including when a deployment origin is absent
 * or invalid. Only an explicitly configured HTTP loopback app may opt out for
 * local development/QA. Request Host/forwarded headers cannot weaken this.
 * The browser uses its actual origin so refreshes cannot downgrade HTTPS
 * cookies even when the build's canonical origin points at a local server.
 */
export function authCookieOptions(requestIsHttps = false): { secure: boolean } {
  // Transport hints may only strengthen the policy, never relax it. This
  // supports a local TLS proxy alongside the explicitly configured HTTP app.
  if (requestIsHttps || (typeof window === "undefined" && process.env.VERCEL === "1")) {
    return { secure: true };
  }
  const origin = typeof window === "undefined"
    ? process.env.NEXT_PUBLIC_SITE_URL
    : window.location.origin;
  try {
    const url = new URL(origin ?? "");
    const localHttp =
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username && !url.password;
    return { secure: !localHttp };
  } catch {
    return { secure: true };
  }
}
