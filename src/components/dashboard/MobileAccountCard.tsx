"use client";

import { LogoutButton } from "@/components/dashboard/LogoutButton";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { getUserMessages } from "@/shared/i18n/user";

const COPY = {
  en: { heading: "Account" },
  vi: { heading: "Tài khoản" },
} as const;

type Props = {
  userEmail: string | null;
  role: string;
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

export function MobileAccountCard({ userEmail, role }: Props) {
  const { language } = useUserLanguage();
  const messages = getUserMessages(language);
  const t = COPY[language];
  const roleLabels = messages.chooseSalon.roleBadge;

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

      <div className="mt-4">
        <LogoutButton language={language} />
      </div>
    </section>
  );
}
