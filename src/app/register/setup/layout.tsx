import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Set up your salon",
  description: "Name your salon and create your NailIQ booking page.",
};

export default function RegisterSetupLayout({ children }: { children: ReactNode }) {
  return children;
}
