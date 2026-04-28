import { RegisterPageClient } from "@/app/register/RegisterPageClient";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";

export const dynamic = "force-dynamic";

export default function RegisterPage() {
  return <RegisterPageClient demoMode={isDemoOtpRuntime()} />;
}
