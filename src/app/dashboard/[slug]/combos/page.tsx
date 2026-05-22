import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { CombosPanel } from "@/components/dashboard/CombosPanel";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Bundles · ${slug}`,
    robots: "noindex",
  };
}

export default async function CombosPage({ params }: PageProps) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");
  const { supabase, salon } = ctx;

  const [{ data: combos }, { data: services }] = await Promise.all([
    supabase
      .from("service_combos" as never)
      .select("id, name, description, service_ids, price_cents, discount_cents, duration_minutes, is_active, position")
      .eq("salon_id", salon.id)
      .order("position", { ascending: true }),
    supabase
      .from("services")
      .select("id, name, duration_minutes, price_cents")
      .eq("salon_id", salon.id)
      .is("deleted_at" as never, null)
      .order("name"),
  ]);

  return (
    <CombosPanel
      salonId={salon.id}
      slug={slug}
      combos={(combos ?? []) as ComboRow[]}
      services={(services ?? []) as ServiceOption[]}
    />
  );
}

export type ComboRow = {
  id: string;
  name: string;
  description: string | null;
  service_ids: string[];
  price_cents: number;
  discount_cents: number;
  duration_minutes: number;
  is_active: boolean;
  position: number;
};

export type ServiceOption = {
  id: string;
  name: string;
  duration_minutes: number | null;
  price_cents: number | null;
};
