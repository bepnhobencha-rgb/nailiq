import { RegisterPageClient } from "@/app/register/RegisterPageClient";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";

export default function RegisterPage() {
  return <RegisterPageClient demoMode={isDemoOtpRuntime()} />;
}
