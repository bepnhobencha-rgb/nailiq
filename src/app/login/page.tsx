import { cancellationFeeReturnPath } from "@/shared/auth/cancellationFeeReturnPath";
import { LoginPageClient } from "@/app/login/LoginPageClient";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";
import { readAuthPlatformFlags } from "@/shared/register/platformFlagReader";

export const dynamic = "force-dynamic";

export const metadata = {
  title: { absolute: "Đăng nhập · NailIQ" },
  robots: "noindex",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string; reset?: string; next?: string }>;
}) {
  const demoMode = isDemoOtpRuntime();
  const { notice, error, reset, next } = await searchParams;

  // In demo mode always fall back to the phone/OTP path so local dev
  // isn't affected by the platform flag state. Mirrors /register.
  const { smsEnabled, emailEnabled } = demoMode
    ? { smsEnabled: true, emailEnabled: false }
    : await readAuthPlatformFlags();

  return (
    <LoginPageClient
      demoMode={demoMode}
      returnTo={cancellationFeeReturnPath(next)}
      smsEnabled={smsEnabled}
      emailEnabled={emailEnabled}
      showConfirmEmailNotice={notice === "confirm-email"}
      showPasswordResetNotice={reset === "ok"}
      authError={
        error === "pkce_restart"
          ? "pkce_restart"
          : error === "link_session_expired"
            ? "link_session_expired"
            : error === "session"
              ? "session"
              : null
      }
    />
  );
}
