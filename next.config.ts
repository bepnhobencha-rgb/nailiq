import type { NextConfig } from "next";

// `upgrade-insecure-requests` must only be sent over HTTPS. Playwright WebKit
// (unlike Chromium) does not respect the spec exception for localhost and will
// upgrade http://localhost:3000/_next/static/... to https://localhost:3000/...,
// causing all JS bundles to fail to load and React to never hydrate in CI E2E.
// Omit the directive when the site URL is HTTP (local dev / CI test server).
const isHttpsOrigin = (process.env.NEXT_PUBLIC_SITE_URL ?? "").startsWith("https://");

/**
 * The Supabase origin this build actually talks to, added to `connect-src`.
 *
 * The CSP allowed `https://*.supabase.co` and nothing else, which is fine for as
 * long as Supabase is only ever the hosted product. Point the app at a local
 * stack — `http://127.0.0.1:54321` — and the browser silently refuses every
 * request to it:
 *
 *   Fetch API cannot load http://127.0.0.1:54321/rest/v1/rpc/… Refused to
 *   connect because it violates the document's Content Security Policy.
 *
 * Nothing throws on the server, so the app shows its catch-all — "Could not
 * complete booking. Please try again." — and the cause is invisible unless you
 * open the browser console. It cost this audit an entire wrong conclusion: the
 * public booking was reported as a product bug when the product was fine and the
 * page simply could not reach its database.
 *
 * Deriving the origin from the configured URL is the correct rule for ANY
 * deployment, not a test-only escape hatch: whatever Supabase this build is
 * pointed at is exactly the Supabase the browser must be allowed to call. In
 * production it re-adds the host that `*.supabase.co` already covered, so the
 * policy is unchanged there.
 */
export function supabaseConnectSrc(
  raw: string | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL,
): string[] {
  const value = (raw ?? "").trim();
  if (!value) return [];

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return []; // Garbage in, nothing out — never a malformed CSP.
  }

  // Only http(s). A `data:` or `javascript:` URL yields origin "null", and
  // pushing the literal string `null` into connect-src is the kind of sloppiness
  // that becomes a finding later. Anything that is not a real network origin is
  // simply not an origin we need to allow.
  if (url.protocol !== "http:" && url.protocol !== "https:") return [];

  const { origin } = url;
  // `origin` is scheme://host[:port] and by construction cannot contain a space
  // or a semicolon, so it cannot break out of the directive and inject another
  // one. That is the property that makes this safe to build from an env var.
  if (/[\s;,']/.test(origin)) return [];

  // Realtime rides the same origin: http→ws, https→wss.
  return [origin, origin.replace(/^http/, "ws")];
}

/**
 * Redirect legacy dashboard URLs at the HTTP routing layer.
 *
 * This must not live in an App Router page component: a `redirect()` thrown
 * while React is mounting the legacy route still asks the client router to
 * process a flight response. Production browsers with an already-mounted
 * dashboard can then hit React's hook-order invariant before the destination
 * loads. A Next config redirect returns the 307 before React or RSC runs and
 * preserves query parameters such as `?range=week`.
 */
export function appRedirects() {
  return [
    {
      source: "/dashboard/:slug/reports",
      destination: "/dashboard/:slug/insights",
      permanent: false,
    },
    // Pricing lives on the home page for now
    { source: "/pricing", destination: "/#pricing", permanent: false },
    // Placeholder pages redirect to contact until real pages exist
    { source: "/help", destination: "/contact", permanent: false },
    { source: "/docs", destination: "/contact", permanent: false },
    { source: "/blog", destination: "/", permanent: false },
    { source: "/changelog", destination: "/", permanent: false },
    { source: "/careers", destination: "/contact", permanent: false },
    { source: "/press", destination: "/contact", permanent: false },
    // External status page
    {
      source: "/status",
      destination: "https://www.vercel-status.com",
      permanent: false,
    },
  ];
}

const nextConfig: NextConfig = {
  async headers() {
    const cspDirectives = [
      "default-src 'self'",
      // Square Web Payments SDK (card-on-file) requires web.squarecdn.com in
      // script/frame/connect + pci-connect for tokenization + its font hosts
      // (per https://developer.squareup.com/docs/web-payments/content-security-policy).
      // Both production + sandbox domains so any salon environment works.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.vercel-scripts.com https://js.stripe.com https://web.squarecdn.com https://sandbox.web.squarecdn.com",
      // Square's Web Payments SDK injects an EXTERNAL stylesheet (card-wrapper.css)
      // from web.squarecdn.com into the parent doc — 'unsafe-inline' alone blocks
      // it and card.attach() throws "unexpected error" (card box never renders).
      // Square's CSP doc omits this; found via repro. Needs the host in style-src.
      "style-src 'self' 'unsafe-inline' https://web.squarecdn.com https://sandbox.web.squarecdn.com",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data: https://square-fonts-production-f.squarecdn.com https://d1g145x70srn7h.cloudfront.net",
      [
        "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.stripe.com https://api.openai.com wss://api.openai.com https://web.squarecdn.com https://sandbox.web.squarecdn.com https://pci-connect.squareup.com https://pci-connect.squareupsandbox.com",
        // Whatever Supabase THIS build is configured against — see the note above.
        // A no-op in production; the difference between working and silently
        // broken when the stack is local.
        ...supabaseConnectSrc(),
      ].join(" "),
      "frame-src https://js.stripe.com https://hooks.stripe.com https://web.squarecdn.com https://sandbox.web.squarecdn.com",
      // Square's Web Payments SDK spins up a Web Worker from a blob: URL; without
      // worker-src it falls back to script-src and is blocked (console error).
      // Card still renders, but allow it so nothing is degraded.
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      ...(isHttpsOrigin ? ["upgrade-insecure-requests"] : []),
    ];
    const commonHeaders = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(self), geolocation=()",
      },
    ];
    return [
      {
        // Everything EXCEPT the embeddable booking route stays frame-DENY
        // (anti-clickjacking on dashboard / auth / payments).
        source: "/((?!embed/).*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          ...commonHeaders,
          { key: "Content-Security-Policy", value: cspDirectives.join("; ") },
        ],
      },
      {
        // Embeddable booking widget route: framable on any site. This is the
        // PUBLIC booking flow only (no auth / no session) — clickjacking risk is
        // low and the multi-step + confirm UI makes it impractical. X-Frame-
        // Options is omitted (deprecated `ALLOW-FROM` is unreliable); CSP
        // `frame-ancestors *` is the modern control. Sensitive surfaces keep DENY
        // via the rule above.
        source: "/embed/:path*",
        headers: [
          ...commonHeaders,
          {
            key: "Content-Security-Policy",
            value: [...cspDirectives, "frame-ancestors *"].join("; "),
          },
        ],
      },
      {
        // Nail Try-On is the only public surface that needs camera access.
        // Browsers still require an explicit user permission prompt; keeping
        // this route-specific avoids widening camera access across NailIQ.
        // This rule must stay after the common rule so its same-name header
        // overrides camera=() only for /:slug/try-on.
        source: "/:slug/try-on",
        headers: [
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
  async redirects() {
    return appRedirects();
  },
};

export default nextConfig;
