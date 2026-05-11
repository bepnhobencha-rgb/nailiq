import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SalonSettingsHub } from "@/components/dashboard/SalonSettingsHub";
import { parseDashboardModules } from "@/shared/dashboard/dashboardModules";
import { parsePresetKey } from "@/shared/dashboard/dashboardPresets";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { normalizeBrandColor } from "@/shared/lib/brandColor";
import { parseSubscriptionPlan } from "@/shared/lib/subscriptionPlans";

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

  const { data: modRow, error: modErr } = await ctx.supabase
    .from("salons")
    .select(
      "dashboard_modules, dashboard_preset, email, email_verified, subscription_plan, brand_color",
    )
    .eq("id", ctx.salon.id)
    .maybeSingle();

  if (modErr) {
    console.error(
      "[SalonSettingsPage] dashboard_modules / dashboard_preset",
      modErr,
    );
  }

  const row = (modRow ?? null) as
    | {
        dashboard_modules?: unknown;
        dashboard_preset?: unknown;
        email?: unknown;
        email_verified?: unknown;
        subscription_plan?: unknown;
        brand_color?: unknown;
      }
    | null;

  const dashboardModules = parseDashboardModules(row?.dashboard_modules);
  const dashboardPreset = parsePresetKey(row?.dashboard_preset);
  const canEditDashboardModules = ctx.role === "owner";

  const salonEmail =
    typeof row?.email === "string" && row.email.trim().length > 0
      ? row.email.trim()
      : null;
  const emailVerified = row?.email_verified === true;
  const subscriptionPlan = parseSubscriptionPlan(row?.subscription_plan);
  const brandColor = normalizeBrandColor(row?.brand_color);

  return (
    <SalonSettingsHub
      slug={slug}
      dashboardModules={dashboardModules}
      dashboardPreset={dashboardPreset}
      canEditDashboardModules={canEditDashboardModules}
      salonEmail={salonEmail}
      emailVerified={emailVerified}
      subscriptionPlan={subscriptionPlan}
      brandColor={brandColor}
    />
  );
}
