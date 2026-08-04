"use client";

import Link from "next/link";
import { Check, Monitor } from "lucide-react";
import { LogoutButton } from "@/components/dashboard/LogoutButton";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { getUserMessages } from "@/shared/i18n/user";
import type { OwnerSalonSummary } from "@/shared/dashboard/salonOwnerActions";

const COPY = {
  en: { heading: "Account" },
  vi: { heading: "Tài khoản" },
} as const;

type Props = {
  userEmail: string | null;
  role: string;
  /** Current salon slug — used to identify "other" salons in the switcher. */
  slug: string;
  /** Display name of the current salon (shown with ✓ in the switcher). */
  salonName?: string;
  /** All salons owned by this user. Switcher renders only when length > 1. */
  salons?: OwnerSalonSummary[];
};

function localizedRoleLabel(
  role: string,
  labels: { owner: string; admin: string; senior: string; nail_tech: string; receptionist: string },
): string {
  if (role === "owner") return labels.owner;
  if (role === "admin") return labels.admin;
  if (role === "senior") return labels.senior;
  if (role === "receptionist") return labels.receptionist;
  if (role === "nail_tech") return labels.nail_tech;
  return role || labels.nail_tech;
}

function SalonAvatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-nq-primary/15 text-xs font-bold tracking-tight text-nq-primary"
    >
      {(name.trim().charAt(0) || "S").toUpperCase()}
    </span>
  );
}

export function MobileAccountCard({
  userEmail,
  role,
  slug,
  salonName,
  salons = [],
}: Props) {
  const { language } = useUserLanguage();
  const messages = getUserMessages(language);
  const t = COPY[language];
  const roleLabels = messages.chooseSalon.roleBadge;

  // Only show the switcher when the owner has more than one salon.
  const otherSalons = salons.filter((s) => s.slug !== slug);
  const showSwitcher = otherSalons.length > 0;
  const currentName = salonName ?? slug;
  const canManageSessions = ["owner", "admin", "manager"].includes(role);

  return (
    <section
      data-testid="mobile-account-card"
      className="md:hidden mt-6 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-4"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
        {t.heading}
      </p>

      <div className="mt-3 flex flex-col gap-1">
        {userEmail ? (
          <p className="break-all text-sm text-nq-foreground">{userEmail}</p>
        ) : null}
        <p className="text-xs text-nq-muted">
          {localizedRoleLabel(role, roleLabels)}
        </p>
      </div>

      {/* ── Salon switcher (owner only, >1 salon) ── */}
      {showSwitcher ? (
        <div className="mt-4">
          <div className="border-t border-nq-border/30 pt-3">
            <p className="pb-2 text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
              {messages.nav.switchSalon}
            </p>
            <ul className="flex flex-col gap-0.5">
              {/* Current salon — non-interactive, shows ✓ */}
              <li>
                <div className="flex min-h-9 items-center gap-3 rounded-md px-2 py-1.5 text-sm text-nq-foreground">
                  <SalonAvatar name={currentName} />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {currentName}
                  </span>
                  <Check
                    className="h-4 w-4 shrink-0 text-nq-primary"
                    aria-hidden
                  />
                </div>
              </li>
              {/* Other salons — tappable links */}
              {otherSalons.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/dashboard/${encodeURIComponent(s.slug)}/center`}
                    className="flex min-h-11 touch-manipulation items-center gap-3 rounded-md px-2 py-2 text-sm text-nq-foreground transition-colors hover:bg-nq-surface/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45"
                  >
                    <SalonAvatar name={s.name} />
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {canManageSessions ? (
        <div className="mt-4 border-t border-nq-border/30 pt-3">
          <Link
            href={`/dashboard/${encodeURIComponent(slug)}/sessions`}
            className="flex min-h-11 touch-manipulation items-center gap-3 rounded-lg px-2 py-2 text-sm font-medium text-nq-foreground transition-colors hover:bg-nq-surface/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45"
          >
            <Monitor className="h-5 w-5 text-nq-primary" aria-hidden />
            {language === "vi" ? "Phiên đăng nhập" : "Active sessions"}
          </Link>
        </div>
      ) : null}

      <div className="mt-4 border-t border-nq-border/30 pt-3">
        <LogoutButton language={language} />
      </div>
    </section>
  );
}
