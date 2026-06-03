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
 *   - Sentry `salon.slug` / `surface` tags + demo-cookie pin both
 *     preserved. ✓
 *   - No deprecation warnings emitted by `npm run build`.
 */
import * as Sentry from "@sentry/nextjs";
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { NAILQ_DEMO_SLUG_COOKIE } from "@/shared/lib/demoDashboardCookie";
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
  "debug-sentry",
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
    Sentry.captureMessage("rate-limit hit: booking-submit", {
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
  if (
    methodEarly === "GET" &&
    isPublicBookingSlugPath(pathnameEarly) &&
    (await checkBookingPageRateLimit(request))
  ) {
    Sentry.captureMessage("rate-limit hit: booking-page-load", {
      level: "info",
      tags: { "rate.limit": "booking-page-load" },
    });
    return rateLimitedResponse(
      "Too many requests. Please try again in a minute.",
    );
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
    Sentry.captureMessage("rate-limit hit: auth-attempt", {
      level: "info",
      tags: { "rate.limit": "auth-attempt", "auth.path": pathnameEarly },
    });
    return rateLimitedResponse(
      "Too many sign-in attempts. Please try again in a minute.",
    );
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, responseHeaders) {
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

  const {
    data: { user },
  } = await supabase.auth.getUser();

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
    Sentry.getCurrentScope().setTag("salon.slug", pathSlug);
    Sentry.getCurrentScope().setTag("surface", "dashboard");
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
    if (!hasSalon && (pathname === "/register" || pathname === "/login" || pathname.startsWith("/dashboard"))) {
      const redirect = NextResponse.redirect(new URL("/register/setup", request.url));
      return applyCookiesFrom(redirect, supabaseResponse);
    }
  }

  // Unauthenticated guards
  if (!user && pathname.startsWith("/dashboard")) {
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
    pathname.startsWith("/superadmin") &&
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
