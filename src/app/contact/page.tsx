import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Contact",
  description: "Get in touch with the NailIQ team in Vancouver, BC.",
};

type ContactItem = {
  label: string;
  email: string;
};

const contacts: ContactItem[] = [
  { label: "General", email: "hello@nailiq.ca" },
  { label: "Support", email: "support@nailiq.ca" },
  { label: "Privacy requests", email: "privacy@nailiq.ca" },
];

export default function ContactPage() {
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
          Contact us
        </h1>
        <p className="mt-3 text-base text-nq-muted">
          Based in Vancouver, BC, Canada. We aim to respond within two
          business days.
        </p>

        <ul className="mt-10 space-y-4">
          {contacts.map((c) => (
            <li
              key={c.email}
              className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-5"
            >
              <p className="text-xs font-semibold tracking-[0.18em] text-nq-muted uppercase">
                {c.label}
              </p>
              <a
                href={`mailto:${c.email}`}
                className="mt-2 inline-block text-lg text-nq-primary underline-offset-4 hover:underline"
              >
                {c.email}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
