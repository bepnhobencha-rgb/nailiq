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
    .select("reminders_enabled, reminder_24h_enabled, reminder_3h_enabled, sms_reminders_enabled, deposit_high_value_cents, deposit_pct_no_show, deposit_pct_high_value, deposit_pct_new_customer, stripe_connect_account_id, stripe_connect_charges_enabled, stripe_connect_details_submitted")
    .eq("id", ctx.salon.id)
    .maybeSingle();

  const row = salonRow as {
    reminders_enabled?: boolean;
    reminder_24h_enabled?: boolean;
    reminder_3h_enabled?: boolean;
    sms_reminders_enabled?: boolean;
    deposit_high_value_cents?: number;
    deposit_pct_no_show?: number;
    deposit_pct_high_value?: number;
    deposit_pct_new_customer?: number;
    stripe_connect_account_id?: string | null;
    stripe_connect_charges_enabled?: boolean;
    stripe_connect_details_submitted?: boolean;
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
      smsRemindersEnabled={row?.sms_reminders_enabled ?? false}
      depositHighValueCents={row?.deposit_high_value_cents ?? 10000}
      depositPctNoShow={row?.deposit_pct_no_show ?? 50}
      depositPctHighValue={row?.deposit_pct_high_value ?? 30}
      depositPctNewCustomer={row?.deposit_pct_new_customer ?? 20}
      connectHasAccount={Boolean(row?.stripe_connect_account_id)}
      connectChargesEnabled={row?.stripe_connect_charges_enabled ?? false}
      connectDetailsSubmitted={row?.stripe_connect_details_submitted ?? false}
      summary={result.summary!}
      unconfirmed={result.unconfirmed!}
      waitlist={result.waitlist!}
    />
  );
}
