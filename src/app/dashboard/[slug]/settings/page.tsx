import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SalonSettingsHub } from "@/components/dashboard/SalonSettingsHub";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Settings · ${slug}`,
    description:
      "Manage services, staff, opening hours, and salon address.",
  };
}

export default async function SalonSettingsPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    redirect("/register");
  }

  return <SalonSettingsHub slug={slug} />;
}
