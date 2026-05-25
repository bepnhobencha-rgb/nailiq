import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { getLoyaltyProgram } from "@/shared/loyalty/loyaltyActions";
import { listGiftCards } from "@/shared/loyalty/giftCardActions";
import { getEffectivePlan } from "@/shared/lib/subscriptionPlans";
import { LoyaltySetupClient } from "@/components/dashboard/LoyaltySetupClient";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Loyalty & Gift Cards · ${slug}`, robots: "noindex" };
}

export default async function LoyaltySetupPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");

  const { supabase, salon } = ctx;

  const { data: salonRow } = await supabase
    .from("salons" as never)
    .select("subscription_plan, plan_override, feature_flags")
    .eq("id", salon.id)
    .maybeSingle();

  const plan = getEffectivePlan({
    subscription_plan: (salonRow as { subscription_plan?: string } | null)?.subscription_plan ?? null,
    plan_override: (salonRow as { plan_override?: string } | null)?.plan_override ?? null,
    feature_flags: (salonRow as { feature_flags?: Record<string, unknown> } | null)?.feature_flags ?? null,
  });

  const isPremium = plan === "premium";

  const { data: services } = await supabase
    .from("services" as never)
    .select("id, name")
    .eq("salon_id", salon.id)
    .is("deleted_at" as never, null)
    .order("name", { ascending: true });

  const [program, giftCards] = await Promise.all([
    isPremium ? getLoyaltyProgram(slug) : Promise.resolve(null),
    isPremium ? listGiftCards(slug) : Promise.resolve([]),
  ]);

  return (
    <LoyaltySetupClient
      slug={slug}
      salonId={salon.id}
      isPremium={isPremium}
      program={program}
      giftCards={giftCards}
      services={(services ?? []) as { id: string; name: string }[]}
    />
  );
}
