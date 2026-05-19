import type { Metadata } from "next";
import Link from "next/link";
import { LandingNavbar } from "@/components/landing/LandingNavbar";
import { LandingFooter } from "@/components/landing/LandingFooter";

export const metadata: Metadata = {
  title: "About",
  description:
    "NailIQ is a Canadian-built salon booking and operations platform — designed for nail salons from Vancouver to Toronto.",
};

export default function AboutPage() {
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
            About NailIQ
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-nq-muted">
            Built in Vancouver, BC — for Canadian nail salons.
          </p>

          <div className="mt-10 space-y-10 text-base leading-relaxed text-nq-foreground/90">
            <section>
              <h2 className="text-xl font-semibold text-nq-foreground">
                Our mission
              </h2>
              <p className="mt-3">
                NailIQ exists to give independent nail salon owners the same
                operational tools that large chains have — without the
                enterprise price tag or the complexity. We believe every salon
                deserves a smart booking system, a real-time receptionist
                view, and the ability to grow without hiring more admin staff.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-nq-foreground">
                Made in Canada
              </h2>
              <p className="mt-3">
                NailIQ is a Canadian product, built from the ground up with
                Canadian salons in mind. Our pricing is in CAD, our compliance
                is built around PIPEDA and CASL, and our default timezone and
                phone-number handling match the Canadian market. We are not a
                US product with a Canadian SKU — this is home.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-nq-foreground">
                What we build
              </h2>
              <ul className="mt-3 list-disc space-y-2 pl-5">
                <li>
                  <strong>Smart booking pages</strong> — a shareable link your
                  clients can use to book 24/7, no app download required.
                </li>
                <li>
                  <strong>Receptionist Center</strong> — a real-time dashboard
                  showing walk-ins, upcoming bookings, and queue status — all
                  on one screen.
                </li>
                <li>
                  <strong>Staff & service management</strong> — set hours,
                  define services, manage staff profiles, and block time off.
                </li>
                <li>
                  <strong>Group bookings</strong> — handle parties and group
                  appointments without the back-and-forth.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-nq-foreground">
                Get in touch
              </h2>
              <p className="mt-3">
                We&apos;re a small, focused team. We read every email.
              </p>
              <p className="mt-2">
                <Link
                  href="/contact"
                  className="text-nq-primary underline-offset-4 hover:underline"
                >
                  Contact us →
                </Link>
              </p>
            </section>
          </div>
        </div>
      </main>
      <LandingFooter />
    </>
  );
}
