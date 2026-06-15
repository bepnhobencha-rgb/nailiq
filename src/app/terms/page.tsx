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
              Payments, deposits &amp; no-show fees
            </h2>
            <p className="mt-3">
              NailIQ provides software that lets a salon collect deposits and
              no-show fees and keep a card on file, using third-party payment
              processors (Square, Stripe). For those charges the salon — not
              NailIQ — is the <strong>merchant of record</strong>. The salon is
              solely responsible for its cancellation, no-show and deposit
              policy, for disclosing it to and obtaining consent from its
              clients, for the amounts charged, for refunds, and for any
              chargebacks or disputes. NailIQ does not process or hold funds and
              is not a party to the transaction between a salon and its client.
              Card details are handled by the processor under their
              PCI-compliant systems; NailIQ stores only a payment token plus the
              card brand and last four digits, and the customer&apos;s consent
              record.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-nq-foreground">
              Client communications
            </h2>
            <p className="mt-3">
              The salon is responsible for obtaining its clients&apos; consent
              to receive SMS and email and for compliance with applicable laws
              (including Canada&apos;s CASL and the US TCPA/CAN-SPAM). NailIQ
              provides opt-out mechanisms (e.g. STOP for SMS, an unsubscribe link
              for email); salons must honour every opt-out.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-nq-foreground">
              Disclaimer &amp; limitation of liability
            </h2>
            <p className="mt-3">
              The service is provided on an &quot;as is&quot; and &quot;as
              available&quot; basis without warranties of any kind. To the
              maximum extent permitted by law, NailIQ is not liable for
              indirect, incidental, or consequential damages, and is not
              responsible for the relationship or any dispute between a salon and
              its clients. NailIQ&apos;s total liability for any claim is limited
              to the subscription fees you paid in the twelve months before the
              claim.
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
