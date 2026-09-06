import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Workspace created · Đã tạo salon",
  description: "Continue Coco Setup before opening public booking.",
};

export default function RegisterSuccessLayout({ children }: { children: ReactNode }) {
  return children;
}
