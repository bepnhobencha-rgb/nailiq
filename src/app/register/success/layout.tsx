import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Your booking page is ready",
  description: "Copy your NailIQ booking link and share it with clients.",
};

export default function RegisterSuccessLayout({ children }: { children: ReactNode }) {
  return children;
}
