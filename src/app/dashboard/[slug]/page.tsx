import type { Metadata } from "next";
import { createClient } from "@/shared/lib/supabase/server";
import { SalonOwnerDashboard } from "@/components/dashboard/SalonOwnerDashboard";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const supabase = await createClient();
  const { data } = await supabase
    .from("salons")
    .select("name")
    .eq("slug", slug)
    .maybeSingle();

  const name = data?.name?.trim();
  const title = name ? `${name} · Dashboard` : "Salon dashboard";
  return {
    title,
    description: "Today’s bookings, revenue snapshot, and upcoming appointments.",
  };
}

export default async function SalonDashboardPage({ params }: Props) {
  const { slug } = await params;
  return <SalonOwnerDashboard slug={slug} />;
}
