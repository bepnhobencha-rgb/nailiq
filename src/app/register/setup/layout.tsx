import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Salon workspace · Không gian salon",
  description: "Name your salon and prepare a private NailIQ workspace.",
};

export default function RegisterSetupLayout({ children }: { children: ReactNode }) {
  return children;
}
