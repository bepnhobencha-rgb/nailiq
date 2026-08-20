import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How NailIQ collects, uses, and protects your data — PIPEDA, CASL, and Quebec Law 25 compliant.",
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
              Payment information
            </h2>
            <p className="mt-3">
              When a salon collects a deposit or keeps a card on file for a
              no-show fee, the payment is processed by Square or Stripe under
              their PCI-compliant systems. NailIQ <strong>never stores your full
              card number</strong> — only a payment token and the card&apos;s
              brand and last four digits (to show you which card is on file),
              plus a record that you consented and the policy you agreed to. You
              can remove a saved card at any time from the link in your booking
              confirmation. The salon is the merchant for these charges.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-nq-foreground">
              International storage &amp; US residents
            </h2>
            <p className="mt-3">
              Some data is stored on servers located in the United States
              (Supabase, Vercel). By using NailIQ you consent to this
              cross-border transfer; while stored in the US, data may be subject
              to access under US law. If you are a California resident, you have
              rights under the CCPA/CPRA to know what we hold, request deletion,
              and opt out of any &quot;sale&quot; of personal information — we do
              not sell personal information. We will notify affected users and
              the relevant authorities of a privacy breach as required by law.
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
              hosting, Resend for email, and the configured AI providers for
              explicitly enabled AI features). Runtime errors are stored by
              NailIQ&apos;s internal monitor after identifiers are redacted.
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
            <h2 className="text-xl font-semibold text-nq-foreground">SMS Privacy</h2>
            <p className="mt-3">
              When you opt in on a salon&apos;s booking page to receive SMS
              appointment confirmations and reminders, the phone number you
              provide is collected solely for appointment-related
              communications with that salon.
            </p>
            <p className="mt-3">
              SMS consent is never shared with third parties or affiliates for
              marketing purposes, and we do not sell phone numbers. Twilio
              delivers the messages on the salon&apos;s behalf and may not use
              them for any other purpose.
            </p>
            <p className="mt-3">
              You may opt out at any time by replying STOP to any message.
              Reply HELP for assistance. Message frequency varies, message and
              data rates may apply, and consent to receive text messages is
              never a condition of purchasing any service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-nq-foreground">
              Commercial electronic messages (CASL)
            </h2>
            <p className="mt-3">
              Canada&apos;s Anti-Spam Legislation (CASL) governs commercial
              electronic messages sent to Canadian addresses. NailIQ sends
              transactional messages only — appointment confirmations, OTP
              codes, and service notifications required to operate your
              account. We do not send marketing or promotional emails unless
              you have expressly opted in. You may withdraw consent at any
              time by contacting{" "}
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
              Quebec residents — Law 25 (Bill 64)
            </h2>
            <p className="mt-3">
              Quebec&apos;s Act respecting the protection of personal
              information in the private sector (Law 25) grants residents of
              Quebec additional rights, including the right to data
              portability, the right to be forgotten (de-indexation), and the
              right to be informed of any automated decision-making affecting
              you. NailIQ does not make automated decisions with legal or
              similarly significant effects on individuals. If you are a
              Quebec resident and wish to exercise any of these rights,
              contact our Privacy Officer at{" "}
              <a
                href="mailto:privacy@nailiq.ca"
                className="text-nq-primary underline-offset-4 hover:underline"
              >
                privacy@nailiq.ca
              </a>
              . We will respond within the 30-day period prescribed by Law 25.
            </p>
            <p className="mt-3">
              Our Privacy Officer is responsible for compliance with Law 25
              and can be reached at the email above.
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
