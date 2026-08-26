/**
 * Request proxy (Next.js 16 convention).
 *
 * Naming: this file is `src/proxy.ts` exporting `proxy(request)` — Next
 * 16 renamed the legacy `middleware.ts` / `middleware()` convention to
 * `proxy.ts` / `proxy()`. The build registers the entry as "Proxy
 * (Middleware)". Do not rename back to `middleware.ts`; do not add a
 * second one in `src/app/`.
 *
 * Audit (2026-05-09, against Next 16.2.4 + @supabase/ssr 0.10.2):
 *   - `proxy` export name + `config.matcher` shape match Next 16. ✓
 *   - `cookies.getAll` + `setAll(cookiesToSet, responseHeaders)` matches
 *     the `CookieMethodsServer.setAll` signature in @supabase/ssr
 *     0.10.x (header argument is `Record<string, string>`). ✓
 *   - `request.cookies.set(name, value)` and
 *     `response.cookies.set({ ...cookie, secure })` are current
 *     `next/server` APIs (no deprecation in Next 16). ✓
 *   - Internal error reporting + demo-cookie pin are preserved. ✓
 *   - No deprecation warnings emitted by `npm run build`.
 */
import * as ErrorReporter from "@/shared/observability/errorReporter";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { NAILQ_DEMO_SLUG_COOKIE } from "@/shared/lib/demoDashboardCookie";
import {
  isRouteOrUnder,
  isRouteOrUnderAny,
} from "@/shared/lib/routeBoundary";
import {
  DEMO_SALON_SLUG,
  isDemoOtpRuntime,
  isDemoSlugPinBypassed,
} from "@/shared/lib/demoOtpMode";
import {
  checkAuthRateLimit,
  checkBookingPageRateLimit,
  checkBookingRateLimit,
} from "@/shared/lib/rateLimit";
import {
  isPlatformHost,
  resolveCustomDomainSlug,
} from "@/shared/lib/customDomainResolver";
import { consumeEdgeDurableRateLimits } from "@/shared/security/edgeDurableRateLimit";
import { resolveSupabaseServerUrl } from "@/shared/lib/supabase/serverUrl";

/** Public booking slug path: `/<slug>` only (single segment, kebab case).
 *  Excludes `/dashboard`, `/register`, `/login`, `/api`, `/auth`,
 *  `/superadmin`, `/_next`, etc. — those reserved roots are filtered
 *  out separately so we don't rate-limit ourselves into a corner. */
const PUBLIC_BOOKING_SLUG_RE = /^\/([a-z0-9][a-z0-9-]{0,63})\/?$/;
const RESERVED_TOP_LEVEL_SEGMENTS = new Set<string>([
  "api",
  "auth",
  "dashboard",
  "login",
  "register",
  "choose-salon",
  "contact",
  "opengraph-image",
  "privacy",
  "robots.txt",
  "sitemap.xml",
  "superadmin",
  "terms",
]);

/** Returns true when the path is `/<slug>` for a customer booking page
 *  (i.e. not one of the reserved app routes). Used to gate rate-limit
 *  checks against just the public booking surface. */
function isPublicBookingSlugPath(pathname: string): boolean {
  const m = PUBLIC_BOOKING_SLUG_RE.exec(pathname);
  if (!m) return false;
  return !RESERVED_TOP_LEVEL_SEGMENTS.has(m[1]);
}

function rateLimitedResponse(message: string): NextResponse {
  return new NextResponse(message, {
    status: 429,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": "60",
    },
  });
}

function limiterUnavailableResponse(): NextResponse {
  return new NextResponse("Temporarily unavailable. Please try again shortly.", {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": "30",
    },
  });
}

function proxyClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

const PROXY_AUTH_RETRY_DELAYS_MS = [25, 75] as const;

type ProxyAuthUser = Awaited<
  ReturnType<ReturnType<typeof createServerClient>["auth"]["getUser"]>
>["data"]["user"];

type ProxyAuthCookieWrite = {
  name: string;
  value: string;
  options: CookieOptions;
};

type ProxyAuthFlightResult = {
  user: ProxyAuthUser;
  cookieWrites: ProxyAuthCookieWrite[];
};

// In-flight only: a burst of dashboard documents carrying the exact same
// Supabase session shares one authoritative Auth validation. Any token-refresh
// cookie writes produced by the leader are replayed onto every waiting
// response, so coalescing cannot strand followers on an expired token. The map
// key is a SHA-256 digest rather than raw credentials and is removed as soon as
// the active validation settles; there is no post-revocation cache window.
const proxyAuthFlights = new Map<string, Promise<ProxyAuthFlightResult>>();

async function proxyAuthFlightKey(request: NextRequest): Promise<string | null> {
  const authCookies = request.cookies
    .getAll()
    .filter(
      ({ name, value }) =>
        name.startsWith("sb-") && name.includes("-auth-token") && value,
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  if (authCookies.length === 0) return null;
  const material = authCookies
    .map(({ name, value }) => `${name}=${value}`)
    .join("\0");
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function getProxyAuthUserOnce(
  supabase: ReturnType<typeof createServerClient>,
): Promise<ProxyAuthUser> {
  for (let attempt = 0; attempt <= PROXY_AUTH_RETRY_DELAYS_MS.length; attempt += 1) {
    let result: Awaited<ReturnType<typeof supabase.auth.getUser>> | null = null;
    try {
      result = await supabase.auth.getUser();
    } catch {
      result = null;
    }

    if (result?.data.user) return result.data.user;
    const status = result?.error?.status;
    if (!result?.error || status === 400 || status === 401 || status === 403) {
      return null;
    }
    const delay = PROXY_AUTH_RETRY_DELAYS_MS[attempt];
    if (delay !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return null;
}

async function getProxyAuthUser(
  supabase: ReturnType<typeof createServerClient>,
  request: NextRequest,
  cookieWrites: ProxyAuthCookieWrite[],
): Promise<ProxyAuthFlightResult> {
  const key = await proxyAuthFlightKey(request);
  if (!key) {
    return {
      user: await getProxyAuthUserOnce(supabase),
      cookieWrites: [...cookieWrites],
    };
  }

  let flight = proxyAuthFlights.get(key);
  if (!flight) {
    flight = (async () => ({
      user: await getProxyAuthUserOnce(supabase),
      cookieWrites: [...cookieWrites],
    }))();
    proxyAuthFlights.set(key, flight);
    const clear = () => {
      if (proxyAuthFlights.get(key) === flight) proxyAuthFlights.delete(key);
    };
    void flight.then(clear, clear);
  }
  return flight;
}

async function consumeProxyLimit(
  request: NextRequest,
  scope: "booking-page" | "auth" | "public-api",
) {
  return consumeEdgeDurableRateLimits({
    scope,
    material: [proxyClientIp(request)],
    buckets:
      scope === "booking-page"
        ? [
            { name: "minute", limit: 180, windowSeconds: 60 },
            { name: "hour", limit: 1_200, windowSeconds: 3_600 },
          ]
        : scope === "auth"
          ? [
            { name: "five-minute", limit: 20, windowSeconds: 300 },
            { name: "hour", limit: 60, windowSeconds: 3_600 },
          ]
          : [
              { name: "minute", limit: 120, windowSeconds: 60 },
              { name: "hour", limit: 1_200, windowSeconds: 3_600 },
            ],
  });
}

function isEmbedBookingPath(pathname: string): boolean {
  return /^\/embed\/[a-z0-9][a-z0-9-]{0,63}\/?$/.test(pathname);
}

function isPublicAuthAttempt(request: NextRequest): boolean {
  const pathname = request.nextUrl.pathname;
  if (request.method === "POST") {
    return isRouteOrUnderAny(pathname, ["/login", "/register", "/superadmin/login"])
      || pathname === "/superadmin/forgot-password";
  }
  return (
    request.method === "GET" &&
    (pathname === "/auth/callback" || pathname === "/auth/recovery") &&
    request.nextUrl.searchParams.has("code")
  );
}

/** Public browser APIs that either read customer-specific data, mutate public
 * booking state, write telemetry, or can trigger non-trivial DB/provider work.
 * Provider webhooks and authenticated dashboard/internal APIs are deliberately
 * excluded: they have signature/session/secret boundaries and need distinct
 * account-aware throttles rather than a shared source-IP quota. */
const PUBLIC_API_RATE_LIMIT_PREFIXES = [
  "/api/ai/approve",
  "/api/booking-otp",
  "/api/booking/",
  "/api/chat/booking",
  "/api/customer/",
  "/api/errors",
  "/api/gift-card/purchase",
  "/api/nail-tryon/",
  "/api/public/salon-suggestions",
  "/api/quick-rebook",
  "/api/referrals/",
  "/api/trends/click",
  "/api/unsubscribe",
  "/api/upsell",
  "/api/vouchers/",
  "/api/voice/",
  "/api/waitlist/",
] as const;

function isPublicApiBoundary(pathname: string): boolean {
  return PUBLIC_API_RATE_LIMIT_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix),
  );
}

/** Copy cookies from the Supabase session response (refresh via getUser/setAll) onto another response. */
function applyCookiesFrom(
  target: NextResponse,
  source: NextResponse,
): NextResponse {
  const secure = process.env.NODE_ENV === "production";
  for (const cookie of source.cookies.getAll()) {
    target.cookies.set({
      ...cookie,
      secure,
    });
  }
  return target;
}

export async function proxy(request: NextRequest) {
  const pathnameEarly = request.nextUrl.pathname;
  const methodEarly = request.method;

  // ── Custom-domain → tenant rewrite ──────────────────────────────────────
  // A salon can serve its public booking page on its own domain. Only runs
  // for NON-platform hosts, so nailiq.ca / *.vercel.app / localhost traffic is
  // completely untouched (and pays no extra cost). We rewrite ONLY the bare
  // root path to `/<slug>`; the booking page's own asset (/_next) and API
  // (/api/*) sub-requests stay same-origin and pass through unchanged.
  const hostHeader = request.headers.get("host") ?? "";
  if (
    methodEarly === "GET" &&
    pathnameEarly === "/" &&
    hostHeader &&
    !isPlatformHost(hostHeader)
  ) {
    const slug = await resolveCustomDomainSlug(hostHeader);
    if (slug) {
      const durableLimit = await consumeProxyLimit(request, "booking-page");
      if (durableLimit === "limited") {
        return rateLimitedResponse("Too many requests. Please try again in a minute.");
      }
      if (durableLimit === "unavailable") return limiterUnavailableResponse();
      const url = request.nextUrl.clone();
      url.pathname = `/${slug}`;
      ErrorReporter.getCurrentScope().setTag("salon.slug", slug);
      ErrorReporter.getCurrentScope().setTag("surface", "custom-domain");
      return NextResponse.rewrite(url);
    }
  }

  // PWA assets — per-tenant web manifest + generated app icon. Public by
  // design (they only expose the salon name + brand colour already shown on
  // the booking site), so skip the dashboard auth gate: the OS fetches these
  // with no session cookie when the owner installs the dashboard to their
  // home screen, and an auth redirect there would break installation.
  if (
    /^\/dashboard\/[^/]+\/(manifest\.webmanifest|icon)$/.test(pathnameEarly)
  ) {
    return NextResponse.next();
  }

  const publicBookingPageLoad =
    methodEarly === "GET" &&
    (isPublicBookingSlugPath(pathnameEarly) || isEmbedBookingPath(pathnameEarly));

  // Task #09-10 — rate-limit checks at the proxy layer.
  //
  // These call `@vercel/firewall.checkRateLimit(id)` which looks up the
  // rule with that ID in the Vercel WAF dashboard. If no rule is
  // configured the helper returns `false` (fail-open) — see PR body
  // for the rule IDs the project owner needs to create.
  //
  // Run BEFORE the Supabase session bootstrap so a 429 doesn't waste a
  // round-trip to Supabase. Auth/POST checks are method-gated so GET
  // pages on the same paths don't burn the per-IP quota.

  // Booking submission — only fires for POST to `/<slug>` paths that
  // aren't reserved app routes. Today the public booking form goes
  // browser→Supabase directly, so no POST hits this path; the check is
  // here for when `submitPublicBooking` moves to a server action.
  if (
    methodEarly === "POST" &&
    isPublicBookingSlugPath(pathnameEarly) &&
    (await checkBookingRateLimit(request))
  ) {
    ErrorReporter.captureMessage("rate-limit hit: booking-submit", {
      level: "info",
      tags: { "rate.limit": "booking-submit" },
    });
    return rateLimitedResponse(
      "Too many booking attempts. Please try again in a minute.",
    );
  }

  // Booking page load — GET on `/<slug>`. Anti-scrape on the public
  // booking surface; the dashboard rule should be loose (e.g.
  // 60/min/IP) so real users with multiple tabs aren't blocked.
  if (publicBookingPageLoad && (await checkBookingPageRateLimit(request))) {
    ErrorReporter.captureMessage("rate-limit hit: booking-page-load", {
      level: "info",
      tags: { "rate.limit": "booking-page-load" },
    });
    return rateLimitedResponse(
      "Too many requests. Please try again in a minute.",
    );
  }
  if (publicBookingPageLoad) {
    const durableLimit = await consumeProxyLimit(request, "booking-page");
    if (durableLimit === "limited") {
      return rateLimitedResponse("Too many requests. Please try again in a minute.");
    }
    if (durableLimit === "unavailable") return limiterUnavailableResponse();

    // Public booking documents do not need a Supabase user/session bootstrap.
    // Returning immediately after the durable limiter removes one Auth call
    // per anonymous page view and keeps the shared DB pool available for the
    // tenant catalog read. Custom-domain roots already take the equivalent
    // early rewrite path above.
    return NextResponse.next({ request });
  }

  // Auth attempts — POST to `/register` or `/login`. After Task #06
  // the real auth happens client-side via supabase-js (no POST hits
  // these paths today), so this currently only catches direct probes.
  // Supabase Auth has its own rate limits as the primary defence.
  if (
    methodEarly === "POST" &&
    (pathnameEarly === "/register" || pathnameEarly === "/login") &&
    (await checkAuthRateLimit(request))
  ) {
    ErrorReporter.captureMessage("rate-limit hit: auth-attempt", {
      level: "info",
      tags: { "rate.limit": "auth-attempt", "auth.path": pathnameEarly },
    });
    return rateLimitedResponse(
      "Too many sign-in attempts. Please try again in a minute.",
    );
  }
  if (isPublicAuthAttempt(request)) {
    const durableLimit = await consumeProxyLimit(request, "auth");
    if (durableLimit === "limited") {
      return rateLimitedResponse(
        "Too many sign-in attempts. Please try again in a minute.",
      );
    }
    if (durableLimit === "unavailable") {
      // Keep sign-in available during a code/schema rollout mismatch. Direct
      // email actions retain their hashed durable server-action limiter, and
      // Supabase Auth retains its provider-side limits. Public booking and API
      // boundaries below remain fail-closed when their durable limiter is down.
      console.warn(
        "[auth-rate-limit] proxy durable limiter unavailable; using auth provider and server-action limits",
      );
    }
  }

  // Coarse durable abuse ceiling for every explicitly public API boundary.
  // Costly/PII/provider routes also keep their tighter identity/salon/session
  // buckets in the route itself. This first layer protects body parsing and
  // prevents a newly-added public route in a listed namespace from silently
  // reaching privileged work without any durable enforcement.
  if (isPublicApiBoundary(pathnameEarly)) {
    const durableLimit = await consumeProxyLimit(request, "public-api");
    if (durableLimit === "limited") {
      return rateLimitedResponse("Too many requests. Please try again in a minute.");
    }
    if (durableLimit === "unavailable") return limiterUnavailableResponse();
  }

  let supabaseResponse = NextResponse.next({ request });
  const proxyAuthCookieWrites: ProxyAuthCookieWrite[] = [];

  const supabase = createServerClient(
    resolveSupabaseServerUrl()!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, responseHeaders) {
          proxyAuthCookieWrites.splice(
            0,
            proxyAuthCookieWrites.length,
            ...cookiesToSet,
          );
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            supabaseResponse.cookies.set(name, value, options);
          });
          if (responseHeaders) {
            Object.entries(responseHeaders).forEach(([key, value]) => {
              supabaseResponse.headers.set(key, value);
            });
          }
        },
      },
    },
  );

  const authResult = await getProxyAuthUser(
    supabase,
    request,
    proxyAuthCookieWrites,
  );
  for (const cookie of authResult.cookieWrites) {
    request.cookies.set(cookie.name, cookie.value);
    supabaseResponse.cookies.set(cookie.name, cookie.value, cookie.options);
  }
  const user = authResult.user;

  const pathname = request.nextUrl.pathname;
  // Any path under /dashboard/[slug]/… (home, setup/services, setup/staff, etc.)
  const dashSlugMatch = /^\/dashboard\/([^/]+)/.exec(pathname);

  // Demo cookie only honored when demo OTP runtime is enabled. Production
  // builds (DEMO_OTP=false / unset) ignore the cookie entirely — closes the
  // prod attack surface from B-01/B-02.
  //
  // Slug pin (re-introduced after PR #16): the demo cookie ONLY grants
  // access to `DEMO_SALON_SLUG` ("demo-salon"). PR #16 forces every demo
  // registration to that slug, so a non-`demo-salon` cookie value cannot
  // arise from the legitimate flow — and pinning prevents the cookie from
  // being abused to access any tenant's dashboard. The matching server-side
  // gates (`getSalonViaDemoCookie`, `verifyDemoSetupSlug`, `writableSupabase`)
  // enforce the same pin.
  //
  // Test-only bypass: `NAILIQ_TEST_BYPASS_SLUG_PIN=1` falls back to the
  // pre-PR #16 cookie===slug match so E2E tests can use non-`demo-salon`
  // fixture slugs. 🚨 NEVER set this env var on Vercel production.
  let isDemoAccess = false;
  if (dashSlugMatch) {
    const pathSlug = decodeURIComponent(dashSlugMatch[1]);
    ErrorReporter.getCurrentScope().setTag("salon.slug", pathSlug);
    ErrorReporter.getCurrentScope().setTag("surface", "dashboard");
    if (isDemoOtpRuntime()) {
      const demoSlug = request.cookies.get(NAILQ_DEMO_SLUG_COOKIE)?.value;
      isDemoAccess = isDemoSlugPinBypassed()
        ? Boolean(demoSlug && demoSlug === pathSlug)
        : Boolean(
            demoSlug === DEMO_SALON_SLUG && pathSlug === DEMO_SALON_SLUG,
          );
    }
  }

  if (!user && isDemoAccess) {
    return supabaseResponse;
  }

  // Email-confirmation gate (defense-in-depth, independent of the
  // Supabase "Confirm email" dashboard toggle). A session whose email
  // is set but NOT confirmed must never reach a protected surface — it
  // is bounced to /login with a notice. Exemptions:
  //   - Phone-OTP users authenticate via `phone_confirmed_at` and often
  //     have no email at all → `user.email` is null → not gated.
  //   - OAuth (Google) and magic-link users always have
  //     `email_confirmed_at` set → pass.
  //   - Demo runtime is never gated (demo OTP has no real email step).
  //   - `/auth/*` and `/api/*` stay reachable so the confirmation link
  //     in /auth/callback can actually exchange the code and set
  //     `email_confirmed_at`; gating them would make confirmation
  //     impossible.
  if (
    user &&
    !isDemoOtpRuntime() &&
    !!user.email &&
    !user.email_confirmed_at &&
    !user.phone_confirmed_at
  ) {
    const exempt =
      isRouteOrUnderAny(pathname, ["/auth", "/api"]) || pathname === "/login";
    if (!exempt) {
      const url = new URL("/login", request.url);
      url.searchParams.set("notice", "confirm-email");
      const redirect = NextResponse.redirect(url);
      return applyCookiesFrom(redirect, supabaseResponse);
    }
    // On an exempt path: let it through WITHOUT running the membership
    // guards below, so an unconfirmed user sitting on /login isn't
    // bounced into /register/setup by Rule 2.
    return supabaseResponse;
  }

  // The dashboard root Server Component performs the exact slug membership
  // check and redirects fail-closed. Avoid repeating the proxy's coarse
  // has-any-salon query for this one route; nested dashboard routes retain the
  // proxy gate below because they do not all share the root loader.
  if (user && /^\/dashboard\/[^/]+\/?$/.test(pathname)) {
    return supabaseResponse;
  }

  // Auth guards for logged-in users (check salon membership)
  if (user) {
    const { data: membership } = await supabase
      .from("salon_members")
      .select("salon_id")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();

    const hasSalon = !!membership?.salon_id;

    // Rule 1: Logged-in with salon cannot access /register or /login
    if (hasSalon && (pathname === "/register" || pathname === "/login")) {
      const { data: salon } = await supabase
        .from("salons")
        .select("slug")
        .eq("id", membership.salon_id)
        .maybeSingle();

      const slug = salon?.slug?.trim();
      if (slug) {
        const redirect = NextResponse.redirect(
          new URL(`/dashboard/${encodeURIComponent(slug)}`, request.url),
        );
        return applyCookiesFrom(redirect, supabaseResponse);
      }
      const redirect = NextResponse.redirect(new URL("/register/setup", request.url));
      return applyCookiesFrom(redirect, supabaseResponse);
    }

    // Rule 2: Logged-in WITHOUT salon cannot access /register, /login, or /dashboard
    if (
      !hasSalon &&
      (pathname === "/register" ||
        pathname === "/login" ||
        isRouteOrUnder(pathname, "/dashboard"))
    ) {
      const redirect = NextResponse.redirect(new URL("/register/setup", request.url));
      return applyCookiesFrom(redirect, supabaseResponse);
    }
  }

  // Unauthenticated guards
  if (!user && isRouteOrUnder(pathname, "/dashboard")) {
    const redirect = NextResponse.redirect(new URL("/login", request.url));
    return applyCookiesFrom(redirect, supabaseResponse);
  }

  // SuperAdmin routes: unauthenticated visitors are bounced to
  // /superadmin/login (the dedicated operator sign-in surface). The
  // login route itself is excluded from this gate — it MUST stay
  // reachable while signed out. Per-page membership / role checks
  // (isSuperAdmin / getSuperAdminRole) still run inside the server
  // components so we keep the authoritative gate in one place.
  if (
    !user &&
    isRouteOrUnder(pathname, "/superadmin") &&
    pathname !== "/superadmin/login" &&
    pathname !== "/superadmin/forgot-password" &&
    pathname !== "/superadmin/reset-password"
  ) {
    const redirect = NextResponse.redirect(
      new URL("/superadmin/login", request.url),
    );
    return applyCookiesFrom(redirect, supabaseResponse);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
