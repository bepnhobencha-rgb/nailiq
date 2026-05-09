import { LoginPageClient } from "@/app/login/LoginPageClient";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";

export const dynamic = "force-dynamic";

export const metadata = {
  title: { absolute: "Đăng nhập · NailIQ" },
  robots: "noindex",
};

export default function LoginPage() {
  return <LoginPageClient demoMode={isDemoOtpRuntime()} />;
}
