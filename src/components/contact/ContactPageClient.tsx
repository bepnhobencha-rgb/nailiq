"use client";

import { useMemo } from "react";
import Link from "next/link";
import { getUserMessages } from "@/shared/i18n/user";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { ContactForm } from "@/components/contact/ContactForm";

/** Replace with a real Calendly / Cal.com link when one exists. Today
 *  this falls back to email — clicking opens the user's mail client
 *  with a pre-filled subject so the team still captures the lead. */
const DEMO_BOOKING_URL = "mailto:hello@nailiq.ca?subject=Demo%20request";

export function ContactPageClient() {
  const { language } = useUserLanguage();
  const t = useMemo(
    () => getUserMessages(language).landing.contact,
    [language],
  );

  return (
    <main className="min-h-screen bg-nq-bg text-nq-foreground">
      <div className="mx-auto w-full max-w-3xl px-5 py-12 md:px-8 md:py-16">
        <Link
          href="/"
          className="text-sm text-nq-muted transition hover:text-nq-foreground"
        >
          {t.backToHome}
        </Link>

        <h1 className="mt-8 text-3xl font-semibold tracking-tight md:text-4xl">
          {t.pageTitle}
        </h1>
        <p className="mt-3 text-base text-nq-muted">{t.lede}</p>

        <div className="mt-10">
          <ContactForm />
        </div>

        <div className="mt-8 rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-6 md:p-8">
          <h3 className="text-lg font-semibold text-nq-foreground md:text-xl">
            {t.demoHeading}
          </h3>
          <p className="mt-2 text-sm text-nq-muted md:text-base">
            {t.demoBody}
          </p>
          <a
            href={DEMO_BOOKING_URL}
            className="mt-5 inline-flex items-center justify-center rounded-full border border-nq-primary/40 bg-nq-primary/10 px-5 py-2.5 text-sm font-semibold text-nq-primary-soft transition hover:bg-nq-primary/20"
          >
            {t.demoCta}
          </a>
        </div>

        <div className="mt-8 rounded-2xl border border-nq-border/40 bg-nq-surface/30 p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-nq-muted">
            {t.directEmailHeading}
          </p>
          <p className="mt-2 text-sm text-nq-foreground/80">
            {t.directEmailBody}
          </p>
        </div>
      </div>
    </main>
  );
}
