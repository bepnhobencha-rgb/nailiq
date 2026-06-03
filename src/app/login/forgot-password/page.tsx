import type { Metadata } from "next";
import { ForgotPasswordClient } from "./ForgotPasswordClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Reset your password · NailIQ" },
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-8 px-5 py-16 md:px-8">
      <header className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-nq-muted">
          NailIQ
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
          Reset your password
        </h1>
        <p className="text-sm text-nq-muted">
          Enter the email associated with your salon owner account. If it
          matches, we&apos;ll send a recovery link.
        </p>
      </header>

      <ForgotPasswordClient />
    </main>
  );
}
