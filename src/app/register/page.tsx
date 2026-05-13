import { redirect } from "next/navigation";
import { RegisterPageClient } from "@/app/register/RegisterPageClient";
import { getSalonSlugForLoggedInOwner } from "@/shared/register/getSalonSlugForLoggedInOwner";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  // Already signed in with a salon → straight to dashboard. Sessions
  // without a salon fall through to /register/setup via the
  // /auth/callback flow, so we don't need to redirect them here.
  const slug = await getSalonSlugForLoggedInOwner();
  if (slug) {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }

  return <RegisterPageClient />;
}
