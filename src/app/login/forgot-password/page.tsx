import type { Metadata } from "next";
import { ForgotPasswordClient, ForgotPasswordHeader } from "./ForgotPasswordClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Reset your password · NailIQ" },
  robots: { index: false, follow: false },
};

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const query = await searchParams;
  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-8 px-5 py-16 md:px-8">
      <ForgotPasswordHeader />

      <ForgotPasswordClient
        invalidOrExpired={query.notice === "invalid_or_expired"}
        temporarilyUnavailable={query.notice === "temporarily_unavailable"}
      />
    </main>
  );
}
