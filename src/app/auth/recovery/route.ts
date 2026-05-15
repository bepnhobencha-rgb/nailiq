import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/shared/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Password recovery callback.
 *
 * Supabase's `resetPasswordForEmail({ redirectTo })` sends the user
 * here with `?code=…` (PKCE) after they click the email link. A route
 * handler — not a server component — is the only context where
 * `@supabase/ssr` can persist the freshly-minted session cookies, so
 * the exchange has to happen here before redirecting on.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const errorCode = url.searchParams.get("error_code");

  if (errorCode) {
    const dest = new URL("/superadmin/forgot-password", request.url);
    dest.searchParams.set("error", errorCode);
    return NextResponse.redirect(dest);
  }

  if (!code) {
    return NextResponse.redirect(
      new URL("/superadmin/forgot-password", request.url),
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    console.error("[auth/recovery] exchange failed:", error);
    return NextResponse.redirect(
      new URL("/superadmin/forgot-password", request.url),
    );
  }

  return NextResponse.redirect(
    new URL("/superadmin/reset-password", request.url),
  );
}
