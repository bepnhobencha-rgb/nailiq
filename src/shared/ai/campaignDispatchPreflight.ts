import "server-only";

import { createHash } from "node:crypto";

import {
  decideCampaignPreflight,
  type CampaignPreflightDecision,
  type CampaignPreflightExclusion,
} from "@/shared/ai/campaignPreflightDecision";
import type { ExecutionJobRow } from "@/shared/ai/executionQueue";
import type { CustomerChannelMode } from "@/shared/lib/channelResolver";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const RECIPIENT_CAP = 500;
const COST_CAP_USD_CENTS = 500;
const SMS_COST_USD_CENTS = 0.79;
const EMAIL_COST_USD_CENTS = 0.1;

type ManifestRecipientRow = {
  client_profile_id: string;
  sms: boolean;
  email: boolean;
};

type ProfileRow = {
  id: string;
  phone: string;
  email: string | null;
  marketing_consent_at: string | null;
  marketing_email_consent_at: string | null;
};

type PreferenceRow = {
  client_profile_id: string;
  consent_marketing_sms: boolean;
  consent_marketing_email: boolean;
};

export type CampaignDispatchPreflightSummary = {
  preflight_at: string;
  manifest_id: string;
  manifest_recipient_count: number;
  eligible_count: number;
  sms_recipient_count: number;
  email_recipient_count: number;
  dual_channel_count: number;
  excluded_recent_contact: number;
  excluded_no_consent: number;
  excluded_no_channel: number;
  excluded_missing_profile: number;
  excluded_manifest_channel_unavailable: number;
  estimated_cost_usd_cents: number;
  recipient_cap: 500;
  cost_cap_usd_cents: 500;
  preflight_fingerprint: string;
  dispatch_enabled: false;
  no_messages_sent: true;
};

function chunks<T>(values: T[], size = 100): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

function normalizedPhone(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

function asCustomerChannel(value: unknown): CustomerChannelMode {
  return value === "sms_only" ||
    value === "email_only" ||
    value === "sms_and_email"
    ? value
    : "smart";
}

function countExclusion(
  decisions: CampaignPreflightDecision[],
  exclusion: CampaignPreflightExclusion,
): number {
  return decisions.filter((decision) => decision.exclusion === exclusion).length;
}

/**
 * Revalidates the exact approved manifest against current consent, destination,
 * channel, recent-contact, recipient and cost constraints. This records
 * append-only evidence only; it has no outbound-provider dependency and never
 * changes the job's dispatch_enabled=false safety lock.
 */
export async function preflightCampaignDispatch(input: {
  salonId: string;
  jobId: string;
}): Promise<
  | {
      ok: true;
      summary: CampaignDispatchPreflightSummary;
      preflightId: string;
      status: "ready" | "blocked";
      validUntil: string;
      outcome: "created" | "unchanged" | "refreshed";
    }
  | { ok: false; error: string }
> {
  const db = createServiceRoleClient();
  const { data: rawJob, error: jobError } = await db
    .from("ai_execution_jobs" as never)
    .select("*")
    .eq("id" as never, input.jobId)
    .eq("salon_id" as never, input.salonId)
    .maybeSingle();
  const job = rawJob as ExecutionJobRow | null;
  if (jobError || !job) return { ok: false, error: "job_not_found" };
  if (
    job.action_type !== "bulk_message" ||
    job.status !== "waiting_input" ||
    job.result?.blocker !== "dispatch_not_enabled" ||
    job.payload?.dispatch_enabled !== false
  ) {
    return { ok: false, error: "job_not_preflightable" };
  }

  const { data: approval, error: approvalError } = await db
    .from("approval_requests" as never)
    .select("release_manifest_id, status")
    .eq("id" as never, job.approval_request_id)
    .eq("salon_id" as never, input.salonId)
    .maybeSingle();
  const approvalRow = approval as {
    release_manifest_id: string | null;
    status: string;
  } | null;
  if (
    approvalError ||
    approvalRow?.status !== "approved" ||
    !approvalRow.release_manifest_id
  ) {
    return { ok: false, error: "manifest_not_found" };
  }
  const manifestId = approvalRow.release_manifest_id;

  const [
    { data: manifest, error: manifestError },
    { data: recipientData, error: recipientError },
    { data: salonData, error: salonError },
  ] = await Promise.all([
    db
      .from("ai_campaign_manifests" as never)
      .select("id, audience_fingerprint")
      .eq("id" as never, manifestId)
      .eq("salon_id" as never, input.salonId)
      .maybeSingle(),
    db
      .from("ai_campaign_manifest_recipients" as never)
      .select("client_profile_id, sms, email")
      .eq("manifest_id" as never, manifestId)
      .eq("salon_id" as never, input.salonId)
      .order("client_profile_id" as never),
    db
      .from("salons" as never)
      .select(
        "customer_channel, sms_outbound_enabled, email_outbound_enabled, sms_a2p_registered",
      )
      .eq("id" as never, input.salonId)
      .maybeSingle(),
  ]);
  const manifestRow = manifest as {
    id: string;
    audience_fingerprint: string;
  } | null;
  if (
    manifestError ||
    !manifestRow ||
    manifestRow.audience_fingerprint !== job.payload?.audience_fingerprint
  ) {
    return { ok: false, error: "manifest_mismatch" };
  }
  if (recipientError) return { ok: false, error: "recipients_unavailable" };
  if (salonError || !salonData) return { ok: false, error: "salon_not_found" };

  const recipients = (recipientData ?? []) as ManifestRecipientRow[];
  const profileIds = recipients.map((recipient) => recipient.client_profile_id);
  const profileBatches = profileIds.length
    ? await Promise.all(
        chunks(profileIds).map((batch) =>
          db
            .from("client_profiles" as never)
            .select(
              "id, phone, email, marketing_consent_at, marketing_email_consent_at",
            )
            .in("id" as never, batch),
        ),
      )
    : [];
  const profileError = profileBatches.find((batch) => batch.error)?.error;
  if (profileError) return { ok: false, error: "profile_query_failed" };
  const profiles = profileBatches.flatMap(
    (batch) => (batch.data ?? []) as ProfileRow[],
  );
  const phones = [...new Set(profiles.map((row) => row.phone).filter(Boolean))];

  const [preferenceBatches, recentBatches] = await Promise.all([
    profileIds.length
      ? Promise.all(
          chunks(profileIds).map((batch) =>
            db
              .from("customer_preferences" as never)
              .select(
                "client_profile_id, consent_marketing_sms, consent_marketing_email",
              )
              .eq("salon_id" as never, input.salonId)
              .in("client_profile_id" as never, batch),
          ),
        )
      : [],
    phones.length
      ? Promise.all(
          chunks(phones).map((batch) =>
            db
              .from("booking_notifications" as never)
              .select("client_phone")
              .eq("salon_id" as never, input.salonId)
              .neq("status" as never, "failed")
              .gte(
                "created_at" as never,
                new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
              )
              .in("client_phone" as never, batch),
          ),
        )
      : [],
  ]);
  if (
    preferenceBatches.some((batch) => batch.error) ||
    recentBatches.some((batch) => batch.error)
  ) {
    return { ok: false, error: "preflight_guard_query_failed" };
  }

  const profilesById = new Map(profiles.map((row) => [row.id, row]));
  const preferencesById = new Map(
    preferenceBatches
      .flatMap((batch) => (batch.data ?? []) as PreferenceRow[])
      .map((row) => [row.client_profile_id, row]),
  );
  const recentlyContacted = new Set(
    recentBatches
      .flatMap(
        (batch) =>
          (batch.data ?? []) as Array<{ client_phone: string | null }>,
      )
      .map((row) => normalizedPhone(row.client_phone)),
  );
  const salon = salonData as {
    customer_channel: unknown;
    sms_outbound_enabled: boolean;
    email_outbound_enabled: boolean;
    sms_a2p_registered: boolean;
  };

  const decisions = recipients
    .map((recipient): CampaignPreflightDecision => {
      const profile = profilesById.get(recipient.client_profile_id);
      if (!profile) {
        return {
          client_profile_id: recipient.client_profile_id,
          sms: false,
          email: false,
          exclusion: "missing_profile",
        };
      }
      const preference = preferencesById.get(profile.id);
      return decideCampaignPreflight({
        profile: {
          profileId: profile.id,
          phone: profile.phone,
          email: profile.email,
          legacySmsConsent: Boolean(profile.marketing_consent_at),
          legacyEmailConsent: Boolean(profile.marketing_email_consent_at),
          preference: preference
            ? {
                sms: preference.consent_marketing_sms,
                email: preference.consent_marketing_email,
              }
            : null,
          recentlyContacted: recentlyContacted.has(
            normalizedPhone(profile.phone),
          ),
        },
        manifest: { sms: recipient.sms, email: recipient.email },
        salon: {
          customerChannel: asCustomerChannel(salon.customer_channel),
          smsOutboundEnabled: salon.sms_outbound_enabled === true,
          emailOutboundEnabled: salon.email_outbound_enabled === true,
          smsA2pRegistered: salon.sms_a2p_registered === true,
        },
      });
    })
    .sort((a, b) => a.client_profile_id.localeCompare(b.client_profile_id));

  const eligibleCount = decisions.filter(
    (decision) => decision.exclusion === null,
  ).length;
  const smsCount = decisions.filter((decision) => decision.sms).length;
  const emailCount = decisions.filter((decision) => decision.email).length;
  const dualCount = decisions.filter(
    (decision) => decision.sms && decision.email,
  ).length;
  const fingerprintInput = decisions
    .map(
      (decision) =>
        `${decision.client_profile_id.toLowerCase()}:${
          decision.sms ? "s" : ""
        }${decision.email ? "e" : ""}:${
          decision.exclusion ?? "eligible"
        }`,
    )
    .join("|");
  const preflightAt = new Date().toISOString();
  const summary: CampaignDispatchPreflightSummary = {
    preflight_at: preflightAt,
    manifest_id: manifestId,
    manifest_recipient_count: decisions.length,
    eligible_count: eligibleCount,
    sms_recipient_count: smsCount,
    email_recipient_count: emailCount,
    dual_channel_count: dualCount,
    excluded_recent_contact: countExclusion(decisions, "recent_contact"),
    excluded_no_consent: countExclusion(decisions, "no_consent"),
    excluded_no_channel: countExclusion(decisions, "no_channel"),
    excluded_missing_profile: countExclusion(decisions, "missing_profile"),
    excluded_manifest_channel_unavailable: countExclusion(
      decisions,
      "manifest_channel_unavailable",
    ),
    estimated_cost_usd_cents:
      Math.round(
        (smsCount * SMS_COST_USD_CENTS + emailCount * EMAIL_COST_USD_CENTS) *
          10,
      ) / 10,
    recipient_cap: RECIPIENT_CAP,
    cost_cap_usd_cents: COST_CAP_USD_CENTS,
    preflight_fingerprint: createHash("sha256")
      .update(fingerprintInput)
      .digest("hex"),
    dispatch_enabled: false,
    no_messages_sent: true,
  };

  const { data: transition, error: transitionError } = await db.rpc(
    "record_ai_campaign_dispatch_preflight_fresh" as never,
    {
      p_job_id: job.id,
      p_salon_id: input.salonId,
      p_summary: summary,
      p_decisions: decisions,
    } as never,
  );
  const row = (Array.isArray(transition) ? transition[0] : transition) as
    | {
        outcome?: string;
        preflight_id?: string;
        preflight_status?: "ready" | "blocked";
        preflight_fingerprint?: string;
        valid_until?: string;
      }
    | null;
  if (
    transitionError ||
    !row?.preflight_id ||
    (row.outcome !== "created" &&
      row.outcome !== "unchanged" &&
      row.outcome !== "refreshed") ||
    (row.preflight_status !== "ready" && row.preflight_status !== "blocked") ||
    row.preflight_fingerprint !== summary.preflight_fingerprint ||
    !row.valid_until
  ) {
    return { ok: false, error: "preflight_record_failed" };
  }

  return {
    ok: true,
    summary,
    preflightId: row.preflight_id,
    status: row.preflight_status,
    validUntil: row.valid_until,
    outcome: row.outcome,
  };
}
