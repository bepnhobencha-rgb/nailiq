import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { NAILQ_DEMO_SLUG_COOKIE } from "@/shared/lib/demoDashboardCookie";

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
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            supabaseResponse.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const dashMatch = /^\/dashboard\/([^/]+)\/?$/.exec(pathname);

  // Demo OTP registration sets an httpOnly slug cookie (no Supabase session). Allow
  // dashboard for that slug regardless of build-time NEXT_PUBLIC_DEMO_OTP inlining.
  let isDemoAccess = false;
  if (dashMatch) {
    const pathSlug = decodeURIComponent(dashMatch[1]);
    const demoSlug = request.cookies.get(NAILQ_DEMO_SLUG_COOKIE)?.value;
    isDemoAccess = Boolean(demoSlug && demoSlug === pathSlug);
  }

  if (!user && isDemoAccess) {
    return supabaseResponse;
  }

  if (!user && pathname.startsWith("/dashboard")) {
    return NextResponse.redirect(new URL("/register", request.url));
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
