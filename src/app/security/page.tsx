import type { Metadata } from "next";
import Link from "next/link";
import { LandingNavbar } from "@/components/landing/LandingNavbar";
import { LandingFooter } from "@/components/landing/LandingFooter";

export const metadata: Metadata = {
  title: "Security",
  description:
    "How NailIQ protects your salon data: encryption, access controls, Canadian data handling, and responsible disclosure.",
};

export default function SecurityPage() {
  return (
    <>
      <LandingNavbar />
      <main className="min-h-screen bg-nq-bg text-nq-foreground pt-24">
        <div className="mx-auto w-full max-w-3xl px-5 py-12 md:px-8 md:py-16">
          <Link
            href="/"
            className="text-sm text-nq-muted transition hover:text-nq-foreground"
          >
            ← Back to home
          </Link>

          <h1 className="mt-8 text-3xl font-semibold tracking-tight md:text-4xl">
            Security
          </h1>
          <p className="mt-2 text-sm text-nq-muted">Last updated: May 2026</p>

          <div className="mt-10 space-y-8 text-base leading-relaxed text-nq-foreground/90">
            <section>
              <h2 className="text-xl font-semibold text-nq-foreground">
                Data encryption
              </h2>
              <p className="mt-3">
                All data is encrypted in transit using TLS 1.2+. Data at rest
                is encrypted by Supabase (PostgreSQL on AWS), which uses
                AES-256 encryption at the storage layer. Backups are
                encrypted with the same standard.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-nq-foreground">
                Authentication
              </h2>
              <p className="mt-3">
                Salon owners sign in with a one-time code (OTP) sent to their
                phone via SMS — no passwords to reuse or forget. OTPs expire
                in 60 seconds and are rate-limited per phone number. Sessions
                are managed via Supabase Auth with short-lived JWTs and
                refresh token rotation.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-nq-foreground">
                Access controls
              </h2>
              <p className="mt-3">
                Every salon&apos;s data is isolated at the database level using
                Row-Level Security (RLS) policies. A salon owner can only read
                and write their own salon&apos;s bookings, staff, and settings.
                Service role access is never exposed to the browser. Admin
                endpoints require server-side session verification on every
                request.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-nq-foreground">
                Infrastructure
              </h2>
              <ul className="mt-3 list-disc space-y-2 pl-5">
                <li>
                  <strong>Hosting:</strong> Vercel (edge network, automatic
                  DDoS mitigation, HTTPS everywhere).
                </li>
                <li>
                  <strong>Database:</strong> Supabase managed Postgres with
                  daily automated backups and point-in-time recovery.
                </li>
                <li>
                  <strong>SMS:</strong> Twilio — phone numbers are used for
                  OTP verification only; no SMS content is retained after the
                  auth event.
                </li>
                <li>
                  <strong>Error monitoring:</strong> NailIQ&apos;s internal
                  monitor stores redacted stack traces in the NailIQ database;
                  customer identifiers and bearer values are removed first.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-nq-foreground">
                Canadian data handling
              </h2>
              <p className="mt-3">
                NailIQ operates under PIPEDA. Salon and booking data may be
                stored on Supabase infrastructure in US or Canadian regions
                (Supabase uses AWS us-east-1 by default). We do not sell or
                share your data with third parties for any purpose other than
                operating the service. See our{" "}
                <Link
                  href="/privacy"
                  className="text-nq-primary underline-offset-4 hover:underline"
                >
                  Privacy Policy
                </Link>{" "}
                for full details.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-nq-foreground">
                Responsible disclosure
              </h2>
              <p className="mt-3">
                If you discover a security vulnerability, please email{" "}
                <a
                  href="mailto:security@nailiq.ca"
                  className="text-nq-primary underline-offset-4 hover:underline"
                >
                  security@nailiq.ca
                </a>{" "}
                before public disclosure. We aim to respond within 48 hours
                and will work with you to resolve the issue promptly.
              </p>
            </section>
          </div>
        </div>
      </main>
      <LandingFooter />
    </>
  );
}
