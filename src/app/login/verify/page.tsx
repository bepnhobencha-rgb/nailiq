import { LoginVerifyPageClient } from "@/app/login/verify/LoginVerifyPageClient";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";

export const dynamic = "force-dynamic";

export const metadata = {
  title: { absolute: "Xác thực · NailIQ" },
  robots: "noindex",
};

export default function LoginVerifyPage() {
  return <LoginVerifyPageClient demoMode={isDemoOtpRuntime()} />;
}
