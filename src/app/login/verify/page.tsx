import { cancellationFeeReturnPath } from "@/shared/auth/cancellationFeeReturnPath";
import { LoginVerifyPageClient } from "@/app/login/verify/LoginVerifyPageClient";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";

export const dynamic = "force-dynamic";

export const metadata = {
  title: { absolute: "Xác thực · NailIQ" },
  robots: "noindex",
};

export default async function LoginVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return <LoginVerifyPageClient demoMode={isDemoOtpRuntime()} returnTo={cancellationFeeReturnPath(next)} />;
}
