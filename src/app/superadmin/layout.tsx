import { type ReactNode } from "react";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: { absolute: "NailIQ SuperAdmin" },
  robots: { index: false, follow: false },
};

/**
 * SuperAdmin shell — intentionally minimal. No sidebar, no language
 * toggle, no marketing chrome. This surface is internal (Huy only)
 * and we keep it dense + functional.
 */
export default function SuperAdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-nq-bg text-nq-foreground">{children}</div>
  );
}
