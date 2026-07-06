import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { getLoyaltyProgram } from "@/shared/loyalty/loyaltyActions";
import { listGiftCards } from "@/shared/loyalty/giftCardActions";
import { getEffectivePlan } from "@/shared/lib/subscriptionPlans";
import { isReleaseFeatureVisible } from "@/shared/features/platformFeatureFlags";
import { LoyaltySetupClient } from "@/components/dashboard/LoyaltySetupClient";
import { BirthdayRewardCard } from "@/components/dashboard/BirthdayRewardCard";
import type { BirthdayReward } from "@/shared/loyalty/birthdayRewardActions";

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
  // Salon config is management-only (owner/admin).
  if (ctx.role !== "owner" && ctx.role !== "admin")
    redirect(`/dashboard/${encodeURIComponent(slug)}`);

  const { supabase, salon } = ctx;

  const { data: salonRow } = await supabase
    .from("salons" as never)
    .select("subscription_plan, plan_override, feature_flags, birthday_reward_type, birthday_reward_percent, birthday_reward_amount_cents, birthday_reward_valid_days")
    .eq("id", salon.id)
    .maybeSingle();

  const planFields = (salonRow ?? {}) as {
    subscription_plan?: string | null;
    plan_override?: string | null;
    feature_flags?: Record<string, unknown> | null;
    birthday_reward_type?: string | null;
    birthday_reward_percent?: number | null;
    birthday_reward_amount_cents?: number | null;
    birthday_reward_valid_days?: number | null;
  };
  const birthdayInitial: BirthdayReward = {
    type: (planFields.birthday_reward_type as BirthdayReward["type"]) ?? "none",
    percent: planFields.birthday_reward_percent ?? null,
    amountCents: planFields.birthday_reward_amount_cents ?? null,
    validDays: planFields.birthday_reward_valid_days ?? 30,
  };

  // Release flag `loyalty` (per-salon) AND platform kill-switch gate the page.
  // notFound() when disabled — direct-URL access is refused, not just hidden.
  if (!(await isReleaseFeatureVisible(planFields, "loyalty"))) {
    notFound();
  }

  const plan = getEffectivePlan({
    subscription_plan: planFields.subscription_plan ?? null,
    plan_override: planFields.plan_override ?? null,
    feature_flags: planFields.feature_flags ?? null,
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
    <>
      <LoyaltySetupClient
        slug={slug}
        salonId={salon.id}
        isPremium={isPremium}
        program={program}
        giftCards={giftCards}
        services={(services ?? []) as { id: string; name: string }[]}
      />
      <div className="mx-auto mt-6 w-full max-w-3xl px-4">
        <BirthdayRewardCard slug={slug} initial={birthdayInitial} />
      </div>
    </>
  );
}
