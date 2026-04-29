import { redirect } from "next/navigation";
import { RegisterPageClient } from "@/app/register/RegisterPageClient";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";
import { getSalonSlugForLoggedInOwner } from "@/shared/register/getSalonSlugForLoggedInOwner";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  const demoMode = isDemoOtpRuntime();
  if (!demoMode) {
    const slug = await getSalonSlugForLoggedInOwner();
    if (slug) {
      redirect(`/dashboard/${encodeURIComponent(slug)}`);
    }
  }
  return <RegisterPageClient demoMode={demoMode} />;
}
