import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Get started · Bắt đầu",
  description:
    "Create a private NailIQ salon workspace, then review setup before Go-Live.",
};

export default function RegisterSectionLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
