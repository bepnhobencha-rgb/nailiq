import { redirect } from "next/navigation";
import { RegisterPageClient } from "@/app/register/RegisterPageClient";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";
import { getSalonSlugForLoggedInOwner } from "@/shared/register/getSalonSlugForLoggedInOwner";
import { readAuthPlatformFlags } from "@/shared/register/platformFlagReader";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  const demoMode = isDemoOtpRuntime();
  if (!demoMode) {
    const slug = await getSalonSlugForLoggedInOwner();
    if (slug) {
      redirect(`/dashboard/${encodeURIComponent(slug)}`);
    }
  }

  // In demo mode always fall back to the phone/OTP path so local dev isn't
  // affected by the platform flag state.
  const { smsEnabled, emailEnabled } = demoMode
    ? { smsEnabled: true, emailEnabled: false }
    : await readAuthPlatformFlags();

  return (
    <RegisterPageClient
      demoMode={demoMode}
      smsEnabled={smsEnabled}
      emailEnabled={emailEnabled}
    />
  );
}
