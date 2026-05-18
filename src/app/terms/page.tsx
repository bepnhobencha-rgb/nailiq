import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "Terms of service for NailIQ — salon booking software based in Vancouver, BC.",
};

export default function TermsPage() {
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
          Terms of Service
        </h1>
        <p className="mt-2 text-sm text-nq-muted">Last updated: May 2026</p>

        <div className="mt-10 space-y-8 text-base leading-relaxed text-nq-foreground/90">
          <section>
            <h2 className="text-xl font-semibold text-nq-foreground">
              The service
            </h2>
            <p className="mt-3">
              NailIQ provides salon booking and operations software for nail
              salons, including a public booking page, a real-time
              receptionist center, and salon management tools. The service is
              priced at CAD $39 per month, plus applicable taxes.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-nq-foreground">
              Free trial
            </h2>
            <p className="mt-3">
              New accounts include a 14-day free trial. No credit card is
              required to start the trial. We will not charge you unless you
              choose to continue and add a payment method.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-nq-foreground">
              Cancellation
            </h2>
            <p className="mt-3">
              You may cancel your subscription at any time, with no penalty
              and no cancellation fee. Your account remains active through
              the end of the current billing period.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-nq-foreground">
              Eligibility
            </h2>
            <p className="mt-3">
              You must be at least 18 years old and authorized to act on
              behalf of the salon you register to use NailIQ.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-nq-foreground">
              Your responsibilities
            </h2>
            <p className="mt-3">
              You are responsible for the accuracy of the data you enter
              about your salon, your services, your staff, and your clients,
              and for the relationship you maintain with your clients. You
              are responsible for keeping your account credentials secure.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-nq-foreground">
              Availability
            </h2>
            <p className="mt-3">
              We work hard to keep NailIQ online but we do not guarantee
              uninterrupted access. The service is provided on a best-effort
              basis and may be temporarily unavailable for maintenance or
              due to causes outside our control.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-nq-foreground">
              Governing law
            </h2>
            <p className="mt-3">
              These terms are governed by the laws of the Province of
              British Columbia and the federal laws of Canada applicable in
              British Columbia. Any dispute will be resolved in the courts
              of British Columbia.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-nq-foreground">
              Contact
            </h2>
            <p className="mt-3">
              Questions about these terms:{" "}
              <a
                href="mailto:hello@nailiq.ca"
                className="text-nq-primary underline-offset-4 hover:underline"
              >
                hello@nailiq.ca
              </a>
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
