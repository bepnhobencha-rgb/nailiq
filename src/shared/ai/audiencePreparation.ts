import "server-only";

import { createHash } from "node:crypto";

import { decideAudienceEligibility } from "@/shared/ai/audienceEligibility";
import type { ExecutionJobRow } from "@/shared/ai/executionQueue";
import type { CustomerChannelMode } from "@/shared/lib/channelResolver";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const MAX_AUDIENCE = 500;
const SMS_COST_USD_CENTS = 0.79;
const EMAIL_COST_USD_CENTS = 0.1;

type CandidateRow = {
  client_phone: string | null;
  client_name: string | null;
  client_email: string | null;
};

type ProfileRow = {
  id: string;
  phone: string;
  marketing_consent_at: string | null;
  marketing_email_consent_at: string | null;
};

type PreferenceRow = {
  client_profile_id: string;
  consent_marketing_sms: boolean;
  consent_marketing_email: boolean;
};

export type AudiencePreparationSummary = {
  prepared_at: string;
  segment: "lapsed_regulars_45_365_days";
  candidate_count: number;
  eligible_count: number;
  sms_recipient_count: number;
  email_recipient_count: number;
  dual_channel_count: number;
  excluded_no_consent: number;
  excluded_no_channel: number;
  excluded_recent_contact: number;
  estimated_cost_usd_cents: number;
  candidate_limit: number;
  may_have_more_candidates: boolean;
  audience_fingerprint: string;
  no_messages_sent: true;
};

function normalizedPhone(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

function chunks<T>(values: T[], size = 100): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

function asCustomerChannel(value: unknown): CustomerChannelMode {
  return value === "sms_only" ||
    value === "email_only" ||
    value === "sms_and_email"
    ? value
    : "smart";
}

/**
 * Prepares a conservative, aggregate-only dry run for an approved bulk message.
 * It never calls Twilio/Resend and deliberately leaves the job waiting_input.
 */
export async function prepareExecutionAudience(input: {
  salonId: string;
  jobId: string;
}): Promise<
  | { ok: true; summary: AudiencePreparationSummary }
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
  if (job.action_type !== "bulk_message" || job.status !== "waiting_input") {
    return { ok: false, error: "job_not_preparable" };
  }

  const { data: salonRow, error: salonError } = await db
    .from("salons" as never)
    .select(
      "customer_channel, sms_outbound_enabled, email_outbound_enabled, sms_a2p_registered",
    )
    .eq("id" as never, input.salonId)
    .maybeSingle();
  if (salonError || !salonRow) return { ok: false, error: "salon_not_found" };
  const salon = salonRow as {
    customer_channel: unknown;
    sms_outbound_enabled: boolean;
    email_outbound_enabled: boolean;
    sms_a2p_registered: boolean;
  };

  // This existing stable RPC provides a bounded, salon-scoped segment:
  // regulars with 2+ visits, lapsed 45-365 days, no future booking, and a
  // legacy SMS marketing-consent timestamp. We re-check all consent below.
  const { data: candidateData, error: candidateError } = await db.rpc(
    "winback_candidates" as never,
    {
      p_salon_id: input.salonId,
      p_min_visits: 2,
      p_lapse_days: 45,
      p_max_days: 365,
      p_limit: MAX_AUDIENCE,
    } as never,
  );
  if (candidateError) {
    console.error("[prepareExecutionAudience] candidates", candidateError);
    return { ok: false, error: "candidate_query_failed" };
  }

  const candidates = ((candidateData ?? []) as CandidateRow[]).filter(
    (candidate) => normalizedPhone(candidate.client_phone).length > 0,
  );
  const phones = [...new Set(candidates.map((item) => item.client_phone as string))];

  const [profileBatches, recentBatches] = phones.length
    ? await Promise.all([
        Promise.all(
          chunks(phones).map((batch) =>
            db
          .from("client_profiles" as never)
          .select(
            "id, phone, marketing_consent_at, marketing_email_consent_at",
          )
              .in("phone" as never, batch),
          ),
        ),
        Promise.all(
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
        ),
      ])
    : [[], []];

  const guardError =
    profileBatches.find((batch) => batch.error)?.error ??
    recentBatches.find((batch) => batch.error)?.error;
  if (guardError) {
    console.error(
      "[prepareExecutionAudience] consent/dedupe",
      guardError,
    );
    return { ok: false, error: "audience_guard_query_failed" };
  }

  const profiles = profileBatches.flatMap(
    (batch) => (batch.data ?? []) as ProfileRow[],
  );
  const recentRows = recentBatches.flatMap(
    (batch) =>
      (batch.data ?? []) as Array<{ client_phone: string | null }>,
  );
  const profileIds = profiles.map((profile) => profile.id);
  const preferenceBatches = profileIds.length
    ? await Promise.all(
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
    : [];
  const preferenceError = preferenceBatches.find(
    (batch) => batch.error,
  )?.error;
  if (preferenceError) {
    console.error("[prepareExecutionAudience] preferences", preferenceError);
    return { ok: false, error: "preference_query_failed" };
  }

  const profilesByPhone = new Map(
    profiles.map((profile) => [normalizedPhone(profile.phone), profile]),
  );
  const preferencesByProfile = new Map(
    preferenceBatches
      .flatMap((batch) => (batch.data ?? []) as PreferenceRow[])
      .map((preference) => [
        preference.client_profile_id,
        preference,
      ]),
  );
  const recentlyContacted = new Set(
    recentRows.map((row) => normalizedPhone(row.client_phone)),
  );

  let smsRecipientCount = 0;
  let emailRecipientCount = 0;
  let dualChannelCount = 0;
  let excludedNoConsent = 0;
  let excludedNoChannel = 0;
  let excludedRecentContact = 0;
  const eligibleAudienceKeys: string[] = [];

  for (const candidate of candidates) {
    const phone = normalizedPhone(candidate.client_phone);
    const profile = profilesByPhone.get(phone);
    if (!profile) {
      excludedNoConsent++;
      continue;
    }
    const preference = preferencesByProfile.get(profile.id);
    const decision = decideAudienceEligibility(
      {
        profileId: profile.id,
        phone: candidate.client_phone as string,
        email: candidate.client_email,
        legacySmsConsent: Boolean(profile.marketing_consent_at),
        legacyEmailConsent: Boolean(profile.marketing_email_consent_at),
        preference: preference
          ? {
              sms: preference.consent_marketing_sms,
              email: preference.consent_marketing_email,
            }
          : null,
        recentlyContacted: recentlyContacted.has(phone),
      },
      {
        customerChannel: asCustomerChannel(salon.customer_channel),
        smsOutboundEnabled: salon.sms_outbound_enabled !== false,
        emailOutboundEnabled: salon.email_outbound_enabled !== false,
        smsA2pRegistered: salon.sms_a2p_registered === true,
      },
    );
    if (!decision.eligible) {
      if (decision.reason === "recent_contact") excludedRecentContact++;
      else if (decision.reason === "no_consent") excludedNoConsent++;
      else excludedNoChannel++;
      continue;
    }
    eligibleAudienceKeys.push(
      `${profile.id}:${decision.sms ? "s" : ""}${decision.email ? "e" : ""}`,
    );
    if (decision.sms) smsRecipientCount++;
    if (decision.email) emailRecipientCount++;
    if (decision.sms && decision.email) dualChannelCount++;
  }

  const preparedAt = new Date().toISOString();
  const summary: AudiencePreparationSummary = {
    prepared_at: preparedAt,
    segment: "lapsed_regulars_45_365_days",
    candidate_count: candidates.length,
    eligible_count: eligibleAudienceKeys.length,
    sms_recipient_count: smsRecipientCount,
    email_recipient_count: emailRecipientCount,
    dual_channel_count: dualChannelCount,
    excluded_no_consent: excludedNoConsent,
    excluded_no_channel: excludedNoChannel,
    excluded_recent_contact: excludedRecentContact,
    estimated_cost_usd_cents:
      Math.round(
        (smsRecipientCount * SMS_COST_USD_CENTS +
          emailRecipientCount * EMAIL_COST_USD_CENTS) *
          10,
      ) / 10,
    candidate_limit: MAX_AUDIENCE,
    may_have_more_candidates: candidates.length === MAX_AUDIENCE,
    audience_fingerprint: createHash("sha256")
      .update(eligibleAudienceKeys.sort().join("|"))
      .digest("hex")
      .slice(0, 24),
    no_messages_sent: true,
  };

  const { data: transition, error: updateError } = await db.rpc(
    "record_ai_audience_preparation" as never,
    {
      p_job_id: job.id,
      p_salon_id: input.salonId,
      p_summary: summary,
      p_now: preparedAt,
    } as never,
  );
  if (
    updateError ||
    (transition !== "updated" && transition !== "unchanged")
  ) {
    return { ok: false, error: "job_update_failed" };
  }

  return { ok: true, summary };
}
