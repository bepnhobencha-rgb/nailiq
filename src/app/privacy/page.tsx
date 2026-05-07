import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How NailIQ collects, uses, and protects your data — PIPEDA compliant.",
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-nq-bg text-nq-foreground">
      <div className="mx-auto w-full max-w-3xl px-5 py-12 md:px-8 md:py-16">
        <Link
          href="/"
          className="text-sm text-nq-muted transition hover:text-nq-foreground"
        >
          ← Back to home
        </Link>

        <h1 className="mt-8 text-3xl font-semibold tracking-tight md:text-4xl">
          Privacy Policy
        </h1>
        <p className="mt-2 text-sm text-nq-muted">Last updated: May 2026</p>

        <div className="mt-10 space-y-8 text-base leading-relaxed text-nq-foreground/90">
          <section>
            <h2 className="text-xl font-semibold text-nq-foreground">
              Who we are
            </h2>
            <p className="mt-3">
              NailIQ is a salon booking and operations platform operated from
              Vancouver, British Columbia, Canada. This policy explains what
              personal information we collect, how we use it, and your rights
              under Canada&apos;s Personal Information Protection and
              Electronic Documents Act (PIPEDA).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-nq-foreground">
              What we collect
            </h2>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>
                Salon owner: phone number, salon name, business address, and
                opening hours.
              </li>
              <li>
                Bookings: client first name, phone number, selected service,
                staff, and appointment time.
              </li>
              <li>
                Account activity: sign-in events and basic usage logs needed
                for security and reliability.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-nq-foreground">
              Why we collect it
            </h2>
            <p className="mt-3">
              We use this information solely to provide the booking and
              walk-in queue service: showing your booking page to clients,
              confirming appointments, displaying the live receptionist
              dashboard, and enabling sign-in.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-nq-foreground">
              Where it is stored
            </h2>
            <p className="mt-3">
              Salon and booking data is stored in Supabase, a managed
              Postgres provider, in a US or Canadian data region. Phone
              verification (one-time codes) is sent through Twilio; the phone
              number is verified at sign-in but no SMS content is retained
              beyond the auth event.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-nq-foreground">
              We do not sell your data
            </h2>
            <p className="mt-3">
              NailIQ does not sell, rent, or share salon or client data with
              third parties for marketing. The only third parties involved
              are infrastructure providers strictly required to run the
              service (Supabase for storage, Twilio for SMS, Vercel for
              hosting, Sentry for error monitoring).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-nq-foreground">
              Retention
            </h2>
            <p className="mt-3">
              Account and salon data is kept for as long as the account is
              active. If you ask us to delete your account, we will remove
              your salon data within 30 days, except where retention is
              required by law (for example, tax records).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-nq-foreground">
              Your rights under PIPEDA
            </h2>
            <p className="mt-3">
              You have the right to access the personal information we hold
              about you, correct it if inaccurate, and request its deletion.
              To exercise any of these rights, email{" "}
              <a
                href="mailto:privacy@nailiq.ca"
                className="text-nq-primary underline-offset-4 hover:underline"
              >
                privacy@nailiq.ca
              </a>
              .
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-nq-foreground">
              Contact
            </h2>
            <p className="mt-3">
              Privacy questions or requests:{" "}
              <a
                href="mailto:privacy@nailiq.ca"
                className="text-nq-primary underline-offset-4 hover:underline"
              >
                privacy@nailiq.ca
              </a>
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
