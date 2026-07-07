import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { loadCampaignStats } from "@/shared/reoptin/reoptinCampaign";
import { loadSchedules } from "@/shared/reoptin/campaignSchedule";
import { MarketingCampaigns } from "@/components/dashboard/MarketingCampaigns";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Marketing · ${slug}`, robots: { index: false, follow: false } };
}

export default async function MarketingPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");
  if (!isOwnerOrAdmin(ctx.role)) redirect(`/dashboard/${encodeURIComponent(slug)}`);

  const [stats, schedules, salonRow] = await Promise.all([
    loadCampaignStats(ctx.salon.id),
    loadSchedules(ctx.salon.id),
    ctx.supabase.from("salons").select("timezone").eq("id", ctx.salon.id).maybeSingle(),
  ]);
  const timezone =
    (salonRow.data as { timezone?: string } | null)?.timezone || "America/Los_Angeles";

  return (
    <MarketingCampaigns
      slug={slug}
      salonName={ctx.salon.name ?? slug}
      timezone={timezone}
      stats={stats}
      schedules={schedules}
    />
  );
}
