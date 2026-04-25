import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Enter code",
  description: "Verify to continue with NailIQ salon onboarding.",
};

export default function RegisterVerifyLayout({ children }: { children: ReactNode }) {
  return children;
}
