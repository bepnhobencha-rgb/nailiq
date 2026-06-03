import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/shared/lib/supabase/server";
import { getSuperAdminRole } from "@/shared/lib/superadmin";

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
 *
 * After exchanging the code for a session, we determine whether the
 * user is a superadmin or a salon owner to route them to the correct
 * reset-password page.
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

  // Determine if user is a superadmin or salon owner to route appropriately
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(
      new URL("/superadmin/forgot-password", request.url),
    );
  }

  // Check if user is a superadmin
  const superadminRole = await getSuperAdminRole(user.id);
  if (superadminRole) {
    return NextResponse.redirect(
      new URL("/superadmin/reset-password", request.url),
    );
  }

  // Check if user is a salon member
  const { data: salonMember } = await supabase
    .from("salon_members")
    .select("id")
    .eq("user_id", user.id)
    .single();

  if (salonMember) {
    return NextResponse.redirect(
      new URL("/login/reset-password", request.url),
    );
  }

  // User is neither superadmin nor salon member — treat as invalid recovery
  return NextResponse.redirect(
    new URL("/superadmin/forgot-password", request.url),
  );
}
