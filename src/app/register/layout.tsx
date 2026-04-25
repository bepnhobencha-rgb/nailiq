import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Get started",
  description:
    "Onboard in minutes: verify, name your salon, and get your public booking link.",
};

export default function RegisterSectionLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
