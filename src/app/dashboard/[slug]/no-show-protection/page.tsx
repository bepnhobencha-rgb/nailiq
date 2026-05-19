import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { loadNoShowDashboard } from "@/shared/noshow/noShowDashboardActions";
import { NoShowProtectionHub } from "@/components/dashboard/NoShowProtectionHub";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `No-Show Protection · ${slug}` };
}

export default async function NoShowProtectionPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");

  const { data: salonRow } = await (await import("@/shared/lib/supabase/serviceRole"))
    .createServiceRoleClient()
    .from("salons" as never)
    .select("reminders_enabled, reminder_24h_enabled, reminder_3h_enabled, deposit_high_value_cents")
    .eq("id", ctx.salon.id)
    .maybeSingle();

  const row = salonRow as {
    reminders_enabled?: boolean;
    reminder_24h_enabled?: boolean;
    reminder_3h_enabled?: boolean;
    deposit_high_value_cents?: number;
  } | null;

  const result = await loadNoShowDashboard(slug);
  if (!result.ok) redirect(`/dashboard/${slug}`);

  return (
    <NoShowProtectionHub
      slug={slug}
      isOwner={ctx.role === "owner"}
      remindersEnabled={row?.reminders_enabled ?? false}
      reminder24hEnabled={row?.reminder_24h_enabled ?? true}
      reminder3hEnabled={row?.reminder_3h_enabled ?? true}
      depositHighValueCents={row?.deposit_high_value_cents ?? 10000}
      summary={result.summary!}
      unconfirmed={result.unconfirmed!}
      waitlist={result.waitlist!}
    />
  );
}
