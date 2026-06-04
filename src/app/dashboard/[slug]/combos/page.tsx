import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isReleaseFeatureVisible } from "@/shared/features/platformFeatureFlags";
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

  // PR3: release flag `combos` (Beta, registry-only, default OFF) gates the
  // page. The combos route is not otherwise plan-gated, so fetch the flag
  // inputs here and notFound() when disabled.
  const { data: flagRow } = await supabase
    .from("salons")
    .select(
      "subscription_plan, plan_override, feature_flags, voice_ai_enabled" as never,
    )
    .eq("id", salon.id)
    .maybeSingle();
  const flagFields = (flagRow ?? {}) as {
    subscription_plan?: string | null;
    plan_override?: string | null;
    feature_flags?: Record<string, unknown> | null;
    voice_ai_enabled?: boolean | null;
  };
  if (!(await isReleaseFeatureVisible(flagFields, "combos"))) {
    notFound();
  }

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
