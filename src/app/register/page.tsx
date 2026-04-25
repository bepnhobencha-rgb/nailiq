import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Register",
  description:
    "Create your NailIQ account and start taking AI-powered bookings for your nail salon.",
};

export default function RegisterPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
        Register
      </h1>
      <p className="mt-3 text-pretty text-nq-muted">
        Salon signup is coming soon. Use the home page to get notified when
        spots open.
      </p>
    </main>
  );
}
