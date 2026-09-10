import type { Metadata } from "next";
import { SuperadminForgotPasswordForm, SuperadminForgotPasswordIntro } from "./SuperadminForgotPasswordForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Forgot password · NailIQ SuperAdmin" },
  robots: { index: false, follow: false },
};

export default async function SuperadminForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const query = await searchParams;
  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-8 px-5 py-16 md:px-8">
      <SuperadminForgotPasswordIntro
        invalidOrExpired={query.notice === "invalid_or_expired"}
        temporarilyUnavailable={query.notice === "temporarily_unavailable"}
      />

      <SuperadminForgotPasswordForm />
    </main>
  );
}
