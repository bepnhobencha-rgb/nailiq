import { VerifyPageClient } from "@/app/register/verify/VerifyPageClient";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";

export default function RegisterVerifyPage() {
  return <VerifyPageClient demoMode={isDemoOtpRuntime()} />;
}
