import type { Metadata } from "next";
import { SuperadminForgotPasswordForm } from "./SuperadminForgotPasswordForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Forgot password · NailIQ SuperAdmin" },
  robots: { index: false, follow: false },
};

export default function SuperadminForgotPasswordPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-8 px-5 py-16 md:px-8">
      <header className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-nq-muted">
          NailIQ
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
          Reset SuperAdmin password
        </h1>
        <p className="text-sm text-nq-muted">
          Enter the email associated with your operator account. If it
          matches an active SuperAdmin, we&apos;ll send a recovery link.
        </p>
      </header>

      <SuperadminForgotPasswordForm />
    </main>
  );
}
