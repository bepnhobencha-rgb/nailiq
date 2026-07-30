import type { ExecutionJobStatus } from "@/shared/ai/executionPolicy";
import {
  toSafeExecutionFailureCode,
  type SafeExecutionFailureCode,
} from "@/shared/ai/executionFailure";

export const OWNER_EXECUTION_BLOCKERS = [
  "recipient_selection_required",
  "dispatch_not_enabled",
  "release_approval_required",
] as const;

export type OwnerExecutionBlocker =
  (typeof OWNER_EXECUTION_BLOCKERS)[number];

export type OwnerAudiencePreparation = {
  eligible_count: number;
  sms_recipient_count: number;
  email_recipient_count: number;
  excluded_no_consent: number;
  excluded_no_channel: number;
  excluded_recent_contact: number;
  estimated_cost_usd_cents: number;
  candidate_limit: number;
  may_have_more_candidates: boolean;
  no_messages_sent: true;
};

export type OwnerCampaignDispatchPreflight = {
  valid_until: string;
  freshness_minutes: number;
  preflight_status: "ready" | "blocked";
  eligible_count: number;
  sms_recipient_count: number;
  email_recipient_count: number;
  excluded_recent_contact: number;
  excluded_no_consent: number;
  excluded_no_channel: number;
  excluded_missing_profile: number;
  excluded_manifest_channel_unavailable: number;
  estimated_cost_usd_cents: number;
  recipient_cap: number;
  cost_cap_usd_cents: number;
  within_recipient_cap: boolean;
  within_cost_cap: boolean;
  no_messages_sent: true;
};

export type OwnerCampaignDispatchPlan = {
  recipient_count: number;
  sms_recipient_count: number;
  email_recipient_count: number;
  estimated_cost_usd_cents: number;
  expires_at: string;
  no_messages_sent: true;
};

export type OwnerExecutionResult = {
  blocker: OwnerExecutionBlocker | null;
  audience_preparation: OwnerAudiencePreparation | null;
  dispatch_preflight: OwnerCampaignDispatchPreflight | null;
  dispatch_plan: OwnerCampaignDispatchPlan | null;
};

export type OwnerExecutionJob = {
  id: string;
  approval_request_id: string;
  action_type: string;
  status: ExecutionJobStatus;
  attempt_count: number;
  max_attempts: number;
  last_error: SafeExecutionFailureCode | null;
  result: OwnerExecutionResult | null;
  created_at: string;
};

export type OwnerExecutionJobSource = {
  id: string;
  approval_request_id: string;
  action_type: string;
  status: ExecutionJobStatus;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
};

const BLOCKER_SET = new Set<string>(OWNER_EXECUTION_BLOCKERS);

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeNumber(
  row: Record<string, unknown>,
  key: string,
): number | null {
  const value = row[key];
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : null;
}

function stringValue(
  row: Record<string, unknown>,
  key: string,
): string | null {
  return typeof row[key] === "string" ? row[key] : null;
}

export function toOwnerExecutionBlocker(
  value: unknown,
): OwnerExecutionBlocker | null {
  return typeof value === "string" && BLOCKER_SET.has(value)
    ? (value as OwnerExecutionBlocker)
    : null;
}

function toOwnerAudiencePreparation(
  value: unknown,
): OwnerAudiencePreparation | null {
  const row = objectValue(value);
  if (
    !row ||
    stringValue(row, "prepared_at") === null ||
    row.no_messages_sent !== true
  ) {
    return null;
  }

  const eligibleCount = nonNegativeNumber(row, "eligible_count");
  const smsRecipientCount = nonNegativeNumber(row, "sms_recipient_count");
  const emailRecipientCount = nonNegativeNumber(row, "email_recipient_count");
  const excludedNoConsent = nonNegativeNumber(row, "excluded_no_consent");
  const excludedNoChannel = nonNegativeNumber(row, "excluded_no_channel");
  const excludedRecentContact = nonNegativeNumber(
    row,
    "excluded_recent_contact",
  );
  const estimatedCost = nonNegativeNumber(row, "estimated_cost_usd_cents");
  const candidateLimit = nonNegativeNumber(row, "candidate_limit");
  if (
    eligibleCount === null ||
    smsRecipientCount === null ||
    emailRecipientCount === null ||
    excludedNoConsent === null ||
    excludedNoChannel === null ||
    excludedRecentContact === null ||
    estimatedCost === null ||
    candidateLimit === null ||
    typeof row.may_have_more_candidates !== "boolean"
  ) {
    return null;
  }

  return {
    eligible_count: eligibleCount,
    sms_recipient_count: smsRecipientCount,
    email_recipient_count: emailRecipientCount,
    excluded_no_consent: excludedNoConsent,
    excluded_no_channel: excludedNoChannel,
    excluded_recent_contact: excludedRecentContact,
    estimated_cost_usd_cents: estimatedCost,
    candidate_limit: candidateLimit,
    may_have_more_candidates: row.may_have_more_candidates,
    no_messages_sent: true,
  };
}

function toOwnerCampaignDispatchPreflight(
  value: unknown,
): OwnerCampaignDispatchPreflight | null {
  const row = objectValue(value);
  if (
    !row ||
    stringValue(row, "preflight_at") === null ||
    row.no_messages_sent !== true ||
    row.dispatch_enabled !== false ||
    (row.preflight_status !== "ready" &&
      row.preflight_status !== "blocked") ||
    typeof row.within_recipient_cap !== "boolean" ||
    typeof row.within_cost_cap !== "boolean"
  ) {
    return null;
  }

  const validUntil = stringValue(row, "valid_until");
  const numericKeys = [
    "freshness_minutes",
    "eligible_count",
    "sms_recipient_count",
    "email_recipient_count",
    "excluded_recent_contact",
    "excluded_no_consent",
    "excluded_no_channel",
    "excluded_missing_profile",
    "excluded_manifest_channel_unavailable",
    "estimated_cost_usd_cents",
    "recipient_cap",
    "cost_cap_usd_cents",
  ] as const;
  const values = Object.fromEntries(
    numericKeys.map((key) => [key, nonNegativeNumber(row, key)]),
  ) as Record<(typeof numericKeys)[number], number | null>;
  if (
    validUntil === null ||
    numericKeys.some((key) => values[key] === null)
  ) {
    return null;
  }

  return {
    valid_until: validUntil,
    freshness_minutes: values.freshness_minutes!,
    preflight_status: row.preflight_status,
    eligible_count: values.eligible_count!,
    sms_recipient_count: values.sms_recipient_count!,
    email_recipient_count: values.email_recipient_count!,
    excluded_recent_contact: values.excluded_recent_contact!,
    excluded_no_consent: values.excluded_no_consent!,
    excluded_no_channel: values.excluded_no_channel!,
    excluded_missing_profile: values.excluded_missing_profile!,
    excluded_manifest_channel_unavailable:
      values.excluded_manifest_channel_unavailable!,
    estimated_cost_usd_cents: values.estimated_cost_usd_cents!,
    recipient_cap: values.recipient_cap!,
    cost_cap_usd_cents: values.cost_cap_usd_cents!,
    within_recipient_cap: row.within_recipient_cap,
    within_cost_cap: row.within_cost_cap,
    no_messages_sent: true,
  };
}

function toOwnerCampaignDispatchPlan(
  value: unknown,
): OwnerCampaignDispatchPlan | null {
  const row = objectValue(value);
  if (
    !row ||
    row.no_messages_sent !== true ||
    row.dispatch_enabled !== false ||
    row.plan_status !== "sealed" ||
    stringValue(row, "plan_id") === null ||
    stringValue(row, "plan_fingerprint") === null
  ) {
    return null;
  }

  const expiresAt = stringValue(row, "expires_at");
  const recipientCount = nonNegativeNumber(row, "recipient_count");
  const smsRecipientCount = nonNegativeNumber(row, "sms_recipient_count");
  const emailRecipientCount = nonNegativeNumber(row, "email_recipient_count");
  const estimatedCost = nonNegativeNumber(row, "estimated_cost_usd_cents");
  if (
    expiresAt === null ||
    recipientCount === null ||
    smsRecipientCount === null ||
    emailRecipientCount === null ||
    estimatedCost === null
  ) {
    return null;
  }

  return {
    recipient_count: recipientCount,
    sms_recipient_count: smsRecipientCount,
    email_recipient_count: emailRecipientCount,
    estimated_cost_usd_cents: estimatedCost,
    expires_at: expiresAt,
    no_messages_sent: true,
  };
}

export function toOwnerExecutionResult(
  value: unknown,
): OwnerExecutionResult | null {
  const row = objectValue(value);
  if (!row) return null;

  return {
    blocker: toOwnerExecutionBlocker(row.blocker),
    audience_preparation: toOwnerAudiencePreparation(
      row.audience_preparation,
    ),
    dispatch_preflight: toOwnerCampaignDispatchPreflight(
      row.dispatch_preflight,
    ),
    dispatch_plan: toOwnerCampaignDispatchPlan(row.dispatch_plan),
  };
}

export function toOwnerExecutionJob(
  row: OwnerExecutionJobSource,
): OwnerExecutionJob {
  return {
    id: row.id,
    approval_request_id: row.approval_request_id,
    action_type: row.action_type,
    status: row.status,
    attempt_count: row.attempt_count,
    max_attempts: row.max_attempts,
    last_error:
      row.last_error === null
        ? null
        : toSafeExecutionFailureCode(row.last_error),
    result: toOwnerExecutionResult(row.result),
    created_at: row.created_at,
  };
}
