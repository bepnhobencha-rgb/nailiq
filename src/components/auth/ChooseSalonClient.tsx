"use client";

import Link from "next/link";
import { useMemo, useTransition } from "react";
import { getUserMessages } from "@/shared/i18n/user";
import { type SalonMemberRole } from "@/shared/lib/salonMemberRole";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { signOutAction } from "@/shared/dashboard/salonOwnerActions";

type Card = {
  salonId: string;
  slug: string;
  name: string;
  role: SalonMemberRole;
  href: string;
};

type Props = {
  cards: Card[];
};

export function ChooseSalonClient({ cards }: Props) {
  const { language } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language).chooseSalon, [language]);
  const [signingOut, startSignOut] = useTransition();

  return (
    <main className="min-h-screen bg-nq-bg text-nq-foreground">
      <div className="mx-auto flex w-full max-w-md flex-col gap-8 px-5 py-12 md:py-16">
        <header className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            {t.title}
          </h1>
          <p className="mt-2 text-sm text-nq-muted">{t.subtitle}</p>
        </header>

        <ul className="flex flex-col gap-3">
          {cards.map((c) => (
            <li key={c.salonId}>
              <Link
                href={c.href}
                className="group flex items-center justify-between gap-4 rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-4 transition hover:border-nq-primary/50 hover:bg-nq-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-lg font-semibold text-nq-foreground">
                    {c.name}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-nq-muted">
                    /{c.slug}
                  </p>
                </div>
                <span className="shrink-0 rounded-full border border-nq-primary/30 bg-nq-primary/10 px-2.5 py-1 text-[10px] font-semibold tracking-[0.18em] text-nq-primary uppercase">
                  {t.roleBadge[c.role]}
                </span>
              </Link>
            </li>
          ))}
        </ul>

        <div className="text-center">
          <button
            type="button"
            disabled={signingOut}
            onClick={() => startSignOut(() => signOutAction())}
            className="text-sm text-nq-muted underline-offset-4 transition hover:text-nq-foreground hover:underline disabled:opacity-60"
          >
            {t.signOut}
          </button>
        </div>
      </div>
    </main>
  );
}
