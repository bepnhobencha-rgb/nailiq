import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { loadNoShowDashboard } from "@/shared/noshow/noShowDashboardActions";
import { NoShowProtectionHub } from "@/components/dashboard/NoShowProtectionHub";
import { SquareSyncCard } from "@/components/dashboard/SquareSyncCard";
import { GuidedSetupReturnCard } from "@/components/dashboard/GuidedSetupReturnCard";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { isReleaseFeatureEnabled } from "@/shared/features/featureRegistry";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `No-Show Protection · ${slug}` };
}

export default async function NoShowProtectionPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");

  const sb = (await import("@/shared/lib/supabase/serviceRole")).createServiceRoleClient();
  const { data: salonRow } = await sb
    .from("salons" as never)
    .select("name, vertical, health_ack_required, email_links_enabled, feature_flags, reminders_enabled, reminder_24h_enabled, reminder_3h_enabled, sms_reminders_enabled, deposit_high_value_cents, deposit_pct_no_show, deposit_pct_high_value, deposit_pct_new_customer, deposit_hold_grace_minutes, cancellation_policy, stripe_connect_account_id, stripe_connect_charges_enabled, stripe_connect_details_submitted, payment_provider, noshow_protection_enabled, noshow_fee_percent, noshow_risk_threshold, noshow_group_whole_party, noshow_deposit_escalation_threshold, noshow_require_new_customer, noshow_require_prior_noshow, noshow_min_noshow_count, noshow_require_high_risk, self_cancel_fee_enabled, self_cancel_window_hours, self_cancel_fee_percent")
    .eq("id", ctx.salon.id)
    .maybeSingle();
  // deposit_enabled lives on square_integrations (a salon only has a row once
  // Square is connected) — null row → deposits off.
  const { data: sqRow } = await sb
    .from("square_integrations" as never)
    .select("deposit_enabled, merchant_id, location_id, environment, last_run_at, sync_pull_create, sync_pull_update, sync_pull_cancel, sync_push_create, sync_push_update, sync_push_cancel")
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();
  const sq = sqRow as {
    deposit_enabled?: boolean;
    merchant_id?: string | null;
    location_id?: string | null;
    environment?: string | null;
    last_run_at?: string | null;
    sync_pull_create?: boolean;
    sync_pull_update?: boolean;
    sync_pull_cancel?: boolean;
    sync_push_create?: boolean;
    sync_push_update?: boolean;
    sync_push_cancel?: boolean;
  } | null;
  const depositEnabled = sq?.deposit_enabled === true;

  const row = salonRow as {
    name?: string | null;
    vertical?: string | null;
    health_ack_required?: boolean | null;
    email_links_enabled?: boolean | null;
    feature_flags?: Record<string, unknown> | null;
    reminders_enabled?: boolean;
    reminder_24h_enabled?: boolean;
    reminder_3h_enabled?: boolean;
    sms_reminders_enabled?: boolean;
    deposit_high_value_cents?: number;
    deposit_pct_no_show?: number;
    deposit_pct_high_value?: number;
    deposit_pct_new_customer?: number;
    deposit_hold_grace_minutes?: number;
    cancellation_policy?: { en?: string; vi?: string } | null;
    stripe_connect_account_id?: string | null;
    stripe_connect_charges_enabled?: boolean;
    stripe_connect_details_submitted?: boolean;
    payment_provider?: "square" | "stripe" | null;
    noshow_protection_enabled?: boolean;
    noshow_group_whole_party?: boolean;
    noshow_fee_percent?: number;
    noshow_risk_threshold?: number;
    noshow_deposit_escalation_threshold?: number | null;
    noshow_require_new_customer?: boolean;
    noshow_require_prior_noshow?: boolean;
    noshow_min_noshow_count?: number;
    noshow_require_high_risk?: boolean;
    self_cancel_fee_enabled?: boolean;
    self_cancel_window_hours?: number;
    self_cancel_fee_percent?: number | null;
  } | null;

  // Effective policy text (custom or built-in default) for the editor.
  const { resolvePolicy } = await import("@/shared/lib/cancellationPolicy");
  const policySalonName = (row?.name ?? "").trim() || slug;
  const policyEn = resolvePolicy(row?.cancellation_policy, "en", policySalonName);
  const policyVi = resolvePolicy(row?.cancellation_policy, "vi", policySalonName);

  // Effective health-ack requirement: salon override ?? per-vertical default.
  const { healthAckRequired } = await import("@/shared/lib/healthAck");
  const healthAckEff = healthAckRequired(row?.health_ack_required, row?.vertical);

  const result = await loadNoShowDashboard(slug);
  if (!result.ok) redirect(`/dashboard/${slug}`);
  const guidedSetupEnabled = isReleaseFeatureEnabled(
    { feature_flags: row?.feature_flags },
    "guided_admin_setup",
  );

  return (
    <div className="space-y-6">
    {guidedSetupEnabled ? <GuidedSetupReturnCard slug={slug} /> : null}
    <NoShowProtectionHub
      slug={slug}
      salonId={ctx.salon.id}
      isOwner={isOwnerOrAdmin(ctx.role)}
      autoBookEnabled={row?.feature_flags?.waitlist_auto_book === true}
      remindersEnabled={row?.reminders_enabled ?? false}
      reminder24hEnabled={row?.reminder_24h_enabled ?? true}
      reminder3hEnabled={row?.reminder_3h_enabled ?? true}
      smsRemindersEnabled={row?.sms_reminders_enabled ?? false}
      depositHighValueCents={row?.deposit_high_value_cents ?? 10000}
      depositPctNoShow={row?.deposit_pct_no_show ?? 50}
      depositPctHighValue={row?.deposit_pct_high_value ?? 30}
      depositPctNewCustomer={row?.deposit_pct_new_customer ?? 20}
      depositEnabled={depositEnabled}
      depositHoldGraceMinutes={row?.deposit_hold_grace_minutes ?? 30}
      cancellationPolicyEn={policyEn}
      cancellationPolicyVi={policyVi}
      healthAckEffective={healthAckEff}
      emailLinksEnabled={row?.email_links_enabled !== false}
      connectHasAccount={Boolean(row?.stripe_connect_account_id)}
      connectChargesEnabled={row?.stripe_connect_charges_enabled ?? false}
      connectDetailsSubmitted={row?.stripe_connect_details_submitted ?? false}
      paymentProvider={row?.payment_provider ?? null}
      noshowProtectionEnabled={row?.noshow_protection_enabled ?? false}
      noshowGroupWholeParty={row?.noshow_group_whole_party !== false}
      noshowDepositEscalationThreshold={row?.noshow_deposit_escalation_threshold ?? null}
      noshowRequireNewCustomer={row?.noshow_require_new_customer !== false}
      noshowRequirePriorNoshow={row?.noshow_require_prior_noshow !== false}
      noshowMinNoshowCount={row?.noshow_min_noshow_count ?? 1}
      noshowRequireHighRisk={row?.noshow_require_high_risk !== false}
      noshowFeePercent={row?.noshow_fee_percent ?? 20}
      noshowRiskThreshold={row?.noshow_risk_threshold ?? 60}
      selfCancelFeeEnabled={row?.self_cancel_fee_enabled === true}
      selfCancelWindowHours={row?.self_cancel_window_hours ?? 24}
      selfCancelFeePercent={row?.self_cancel_fee_percent ?? null}
      summary={result.summary!}
      unconfirmed={result.unconfirmed!}
      waitlist={result.waitlist!}
      uncollectedFees={result.uncollectedFees ?? []}
    />
    <SquareSyncCard
      slug={slug}
      isOwner={isOwnerOrAdmin(ctx.role)}
      connected={Boolean(sqRow)}
      merchantId={sq?.merchant_id ?? null}
      locationId={sq?.location_id ?? null}
      environment={sq?.environment ?? null}
      lastRunAt={sq?.last_run_at ?? null}
      initial={{
        sync_pull_create: sq?.sync_pull_create !== false,
        sync_pull_update: sq?.sync_pull_update !== false,
        sync_pull_cancel: sq?.sync_pull_cancel !== false,
        sync_push_create: sq?.sync_push_create === true,
        sync_push_update: sq?.sync_push_update === true,
        sync_push_cancel: sq?.sync_push_cancel === true,
      }}
    />
    </div>
  );
}
