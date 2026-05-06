import * as Sentry from "@sentry/nextjs";
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { NAILQ_DEMO_SLUG_COOKIE } from "@/shared/lib/demoDashboardCookie";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";

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

export async function middleware(request: NextRequest) {
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
  // prod attack surface from B-01/B-02. The earlier slug-restriction (must
  // equal `demo-salon`) was rolled back because it broke the demo register
  // flow for any owner whose existing salon has a non-`demo-salon` slug:
  // verifyRegisterOtp would set the cookie to that slug, then middleware
  // bounced the dashboard hop back to /register. The matching server-side
  // gates (getSalonViaDemoCookie, verifyDemoSetupSlug, writableSupabase)
  // were also relaxed to keep behavior coherent.
  let isDemoAccess = false;
  if (dashSlugMatch) {
    const pathSlug = decodeURIComponent(dashSlugMatch[1]);
    Sentry.getCurrentScope().setTag("salon.slug", pathSlug);
    Sentry.getCurrentScope().setTag("surface", "dashboard");
    if (isDemoOtpRuntime()) {
      const demoSlug = request.cookies.get(NAILQ_DEMO_SLUG_COOKIE)?.value;
      isDemoAccess = Boolean(demoSlug && demoSlug === pathSlug);
    }
  }

  if (!user && isDemoAccess) {
    return supabaseResponse;
  }

  if (!user && pathname.startsWith("/dashboard")) {
    const redirect = NextResponse.redirect(new URL("/register", request.url));
    return applyCookiesFrom(redirect, supabaseResponse);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
