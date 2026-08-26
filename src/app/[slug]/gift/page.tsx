import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: { absolute: "Not found | NailIQ" },
    description: "This page does not exist.",
    robots: { index: false, follow: false },
    alternates: { canonical: null },
  };
}

export default function GiftCardPage() {
  // Permanently retire the legacy public purchase surface. A new paid Square
  // flow must be introduced as a separately reviewed route and UI; a flag may
  // never reveal the old free-value assumptions.
  notFound();
}
