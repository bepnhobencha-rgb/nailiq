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

  if (!user && pathname.startsWith("/dashboard")) {
    const redirect = NextResponse.redirect(new URL("/register", request.url));
    return applyCookiesFrom(redirect, supabaseResponse);
  }

  // SuperAdmin route: unauthenticated users → /login. The page itself
  // does the membership check (isSuperAdmin) and bounces non-admin
  // signed-in users; we keep this layer minimal so the gate logic
  // stays in one place (the page server component).
  if (!user && pathname.startsWith("/superadmin")) {
    const redirect = NextResponse.redirect(new URL("/login", request.url));
    return applyCookiesFrom(redirect, supabaseResponse);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
