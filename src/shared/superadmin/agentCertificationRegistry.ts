import { isReleaseFeatureEnabled } from "@/shared/features/featureRegistry";
import { canRunAutonomousAiForTenant } from "@/shared/ai/tenantExecutionBoundary";

export type AgentEffectLevel =
  | "internal_read"
  | "internal_write"
  | "advisory"
  | "draft"
  | "customer_communication"
  | "policy_write"
  | "booking_operation";

export type AgentTriggerKind = "scheduled" | "event" | "condition" | "mixed";

export type AgentTriggerContract = {
  kind: AgentTriggerKind;
  summary: string;
  /** Maximum age of evidence before it is no longer current for this cadence. */
  freshnessHours: number;
};

export type AgentCostPolicy = {
  kind: "deterministic" | "metered_model" | "channel_only" | "mixed";
  summary: string;
  ledgerFeatures: string[];
};

export type RuntimeEvidenceCategory =
  | "action_audit"
  | "customer_delivery"
  | "decision_audit"
  | "durable_job"
  | "model_execution"
  | "outcome_attribution"
  | "provider_delivery"
  | "session_telemetry"
  | "worker_run"
  | "unavailable";

export type SalonCertificationContext = {
  id: string;
  name: string;
  slug: string;
  feature_flags: Record<string, unknown> | null;
  voice_ai_enabled: boolean | null;
  google_place_id: string | null;
  yelp_business_id: string | null;
  archived_at?: string | null;
  superadmin_locked_at?: string | null;
  subscription_status?: string | null;
  subscription_plan?: string | null;
  plan_override?: string | null;
};

export type CertificationEvidenceRow = {
  salon_id: string | null;
  agent?: string | null;
  action_type?: string | null;
  feature?: string | null;
  status?: string | null;
  model?: string | null;
  realtime_usage?: unknown;
  estimated_cost_usd?: number | string | null;
  created_at?: string | null;
  started_at?: string | null;
  updated_at?: string | null;
  outcome_at?: string | null;
  payload?: unknown;
  mode?: string | null;
  ai_confidence?: string | null;
  applied?: boolean | null;
  worker_name?: string | null;
};

export type CertificationEvidenceInput = {
  actions: CertificationEvidenceRow[];
  usage: CertificationEvidenceRow[];
  voice: CertificationEvidenceRow[];
  policies: CertificationEvidenceRow[];
  jobs: CertificationEvidenceRow[];
};

export type RuntimeEvidencePredicate = {
  category: RuntimeEvidenceCategory;
  summary: string;
  evaluate: (
    input: CertificationEvidenceInput,
    salon: SalonCertificationContext,
  ) => CertificationEvidenceRow[];
};

/**
 * Canonical, typed contract for every autonomous agent or interactive AI
 * surface included in SuperAdmin certification. Adding a surface requires all
 * safety, input/output, retry, cost, and evidence fields at compile time.
 */
export type AgentCertificationDefinition = {
  key: string;
  label: string;
  failureKey: string;
  trigger: AgentTriggerContract;
  permissionContract: string[];
  inputs: string[];
  outputs: string[];
  effectLevel: AgentEffectLevel;
  auditContract: string[];
  retryPolicy: string[];
  costPolicy: AgentCostPolicy;
  configured: (salon: SalonCertificationContext) => boolean;
  runtimeEvidencePredicate: RuntimeEvidencePredicate;
};

const flag = (key: string) => (salon: SalonCertificationContext) =>
  salon.feature_flags?.[key] === true;
const always = () => true;
const anyAiFlag = (salon: SalonCertificationContext) =>
  canRunAutonomousAiForTenant(salon) &&
  Object.entries(salon.feature_flags ?? {}).some(
    ([key, value]) => key.startsWith("ai_") && value === true,
  );
const releaseFeature =
  (key: "admin_copilot" | "group_booking" | "public_booking") =>
  (salon: SalonCertificationContext) =>
    isReleaseFeatureEnabled(salon, key);

function actionTypes(
  agent: string,
  types: readonly string[],
): RuntimeEvidencePredicate["evaluate"] {
  const allowed = new Set(types);
  return (input, salon) => input.actions.filter(
    (row) =>
      row.salon_id === salon.id &&
      row.agent === agent &&
      allowed.has(row.action_type ?? ""),
  );
}

function actionMatcher(
  agent: string,
  matches: (actionType: string) => boolean,
): RuntimeEvidencePredicate["evaluate"] {
  return (input, salon) => input.actions.filter(
    (row) =>
      row.salon_id === salon.id &&
      row.agent === agent &&
      matches(row.action_type ?? ""),
  );
}

function successfulUsage(
  features: readonly string[],
): RuntimeEvidencePredicate["evaluate"] {
  const allowed = new Set(features);
  return (input, salon) => input.usage.filter(
    (row) =>
      row.salon_id === salon.id &&
      allowed.has(row.feature ?? "") &&
      row.status === "succeeded",
  );
}

function lateDeclineDelivery(
  input: CertificationEvidenceInput,
  salon: SalonCertificationContext,
): CertificationEvidenceRow[] {
  return input.actions.filter((row) => {
    if (
      row.salon_id !== salon.id ||
      row.agent !== "minh_late_decline" ||
      row.action_type !== "late_decline_handled" ||
      !row.payload ||
      typeof row.payload !== "object"
    ) return false;
    const outcome = (row.payload as { outcome?: unknown }).outcome;
    return typeof outcome === "string" && /sms_(suggested|waitlist):ok/.test(outcome);
  });
}

function completeVoiceTelemetry(
  input: CertificationEvidenceInput,
  salon: SalonCertificationContext,
): CertificationEvidenceRow[] {
  return input.voice.filter((row) => {
    if (
      row.salon_id !== salon.id ||
      row.status !== "completed" ||
      !row.model?.trim() ||
      row.estimated_cost_usd == null ||
      !row.realtime_usage ||
      typeof row.realtime_usage !== "object"
    ) return false;
    return (row.realtime_usage as { schemaVersion?: unknown }).schemaVersion === 1;
  });
}

const noRuntimeEvidence: RuntimeEvidencePredicate["evaluate"] = () => [];

function contract(
  definition: AgentCertificationDefinition,
): AgentCertificationDefinition {
  return definition;
}

export const AGENT_CERTIFICATION_REGISTRY = [
  contract({
    key: "outcome_tracker",
    label: "Outcome Tracker",
    failureKey: "outcome_tracker",
    trigger: { kind: "scheduled", summary: "Daily at 09:00 salon local time", freshnessHours: 72 },
    permissionContract: ["Tenant must be eligible for autonomous AI", "Reads and updates only the same salon's action attribution"],
    inputs: ["Delivered Win-back, Rebook, First Visit, and VIP actions", "Subsequent non-cancelled bookings within the attribution window"],
    outputs: ["Converted or no-conversion attribution on the source action"],
    effectLevel: "internal_write",
    auditContract: ["ai_actions_log.outcome, outcome_at, outcome_booking_id", "One booking may be attributed only once"],
    retryPolicy: ["Re-evaluated daily until the per-agent attribution deadline", "Last-touch and booking-id deduplication"],
    costPolicy: { kind: "deterministic", summary: "No model call; database attribution only", ledgerFeatures: [] },
    configured: always,
    runtimeEvidencePredicate: {
      category: "outcome_attribution",
      summary: "A source action has a fresh persisted outcome_at timestamp",
      evaluate: (input, salon) => input.actions.filter(
        (row) => row.salon_id === salon.id && Boolean(row.outcome_at),
      ),
    },
  }),
  contract({
    key: "cancellation_radar",
    label: "Cancellation Radar",
    failureKey: "cancellation_radar",
    trigger: { kind: "scheduled", summary: "Daily at 09:00 salon local time", freshnessHours: 72 },
    permissionContract: ["Requires ai_cancellation_radar=true", "Tenant must be eligible for autonomous AI"],
    inputs: ["Current and prior-week booking and cancellation counts"],
    outputs: ["Daily cancellation check", "Monday cancellation summary and owner advisory"],
    effectLevel: "advisory",
    auditContract: ["Exact cancellation_radar action types in ai_actions_log"],
    retryPolicy: ["Hourly manager invocation may retry inside the local 09:00 window", "23-hour action deduplication"],
    costPolicy: { kind: "deterministic", summary: "Rule-based analysis; delivery channel costs may apply", ledgerFeatures: [] },
    configured: flag("ai_cancellation_radar"),
    runtimeEvidencePredicate: {
      category: "action_audit",
      summary: "A fresh daily_cancellation_check or weekly_cancellation_report audit exists",
      evaluate: actionTypes("cancellation_radar", ["daily_cancellation_check", "weekly_cancellation_report"]),
    },
  }),
  contract({
    key: "daily_report",
    label: "Daily Report",
    failureKey: "daily_report",
    trigger: { kind: "scheduled", summary: "Daily at 21:00 when Unified Digest is off", freshnessHours: 72 },
    permissionContract: ["Disabled when ai_unified_digest=true", "Tenant must be eligible for autonomous AI"],
    inputs: ["Today's bookings", "Agent activity", "Operational alerts"],
    outputs: ["Owner daily report with deterministic fallback"],
    effectLevel: "advisory",
    auditContract: ["ai_actions_log action_type=sent_report", "AI usage event when a model is used"],
    retryPolicy: ["Manager retries only inside the local 21:00 window", "Daily action deduplication"],
    costPolicy: { kind: "metered_model", summary: "Haiku when available; deterministic fallback is $0", ledgerFeatures: ["daily_report"] },
    configured: (salon) => salon.feature_flags?.ai_unified_digest !== true,
    runtimeEvidencePredicate: { category: "action_audit", summary: "A fresh persisted sent_report artifact exists", evaluate: actionTypes("daily_report", ["sent_report"]) },
  }),
  contract({
    key: "revenue_report",
    label: "Revenue Report",
    failureKey: "revenue_report",
    trigger: { kind: "scheduled", summary: "Monday at 09:00 salon local time", freshnessHours: 336 },
    permissionContract: ["Requires ai_revenue_report=true", "Tenant must be eligible for autonomous AI"],
    inputs: ["Completed bookings and revenue for current and prior periods"],
    outputs: ["Weekly owner revenue summary"],
    effectLevel: "advisory",
    auditContract: ["ai_actions_log action_type=weekly_revenue_summary", "AI usage ledger"],
    retryPolicy: ["Weekly schedule with action deduplication", "No durable mid-week retry"],
    costPolicy: { kind: "metered_model", summary: "Haiku usage is metered", ledgerFeatures: ["revenue_report"] },
    configured: flag("ai_revenue_report"),
    runtimeEvidencePredicate: { category: "action_audit", summary: "A fresh weekly_revenue_summary audit exists", evaluate: actionTypes("revenue_report", ["weekly_revenue_summary"]) },
  }),
  contract({
    key: "staff_performance",
    label: "Staff Performance",
    failureKey: "staff_performance",
    trigger: { kind: "scheduled", summary: "Monday at 09:00 salon local time", freshnessHours: 336 },
    permissionContract: ["Requires ai_staff_performance=true", "Tenant must be eligible for autonomous AI"],
    inputs: ["Completed bookings grouped by staff member"],
    outputs: ["Weekly owner staff-performance summary"],
    effectLevel: "advisory",
    auditContract: ["ai_actions_log action_type=weekly_staff_summary", "AI usage ledger"],
    retryPolicy: ["Weekly schedule with action deduplication", "No durable mid-week retry"],
    costPolicy: { kind: "metered_model", summary: "Haiku usage is metered", ledgerFeatures: ["staff_performance"] },
    configured: flag("ai_staff_performance"),
    runtimeEvidencePredicate: { category: "action_audit", summary: "A fresh weekly_staff_summary audit exists", evaluate: actionTypes("staff_performance", ["weekly_staff_summary"]) },
  }),
  contract({
    key: "noshow",
    label: "No-show Policy",
    failureKey: "noshow",
    trigger: { kind: "mixed", summary: "Hourly backfill and booking-event evaluation", freshnessHours: 48 },
    permissionContract: ["Requires ai_noshow_policy_shadow=true or ai_noshow_policy_live=true", "Permission is re-read before live policy write", "Never charges a payment method"],
    inputs: ["Booking timing", "Customer no-show history", "Card-on-file and policy context"],
    outputs: ["Shadow/live policy decision", "Optional card-required policy update in live mode"],
    effectLevel: "policy_write",
    auditContract: ["ai_policy_decisions agent=noshow_policy, mode=live, applied=true, and model confidence present", "AI usage ledger", "Rate-limit decision audit", "Human mode=override and shadow-only rows never qualify as a completed live effect"],
    retryPolicy: ["Booking-key deduplication", "Maximum 20 evaluations per salon/hour", "Hourly backfill is capped"],
    costPolicy: { kind: "metered_model", summary: "No-show policy and risk scoring model usage is metered", ledgerFeatures: ["noshow_policy", "noshow_risk_score"] },
    configured: (salon) => salon.feature_flags?.ai_noshow_policy_live === true || salon.feature_flags?.ai_noshow_policy_shadow === true,
    runtimeEvidencePredicate: {
      category: "decision_audit",
      summary: "A fresh live no-show agent decision is applied with model confidence",
      evaluate: (input, salon) => input.policies.filter(
        (row) =>
          row.salon_id === salon.id &&
          row.agent === "noshow_policy" &&
          row.mode === "live" &&
          row.applied === true &&
          (row.ai_confidence === "low" ||
            row.ai_confidence === "medium" ||
            row.ai_confidence === "high"),
      ),
    },
  }),
  contract({
    key: "watchdog",
    label: "Watchdog",
    failureKey: "watchdog",
    trigger: { kind: "condition", summary: "Condition-based, evaluated by the hourly manager", freshnessHours: 720 },
    permissionContract: ["Requires ai_watchdog=true", "Read-only analysis; it alerts but never self-repairs"],
    inputs: ["Operational snapshot, queue health, failures, and stale-state signals"],
    outputs: ["Risk analysis and optional owner/operator alert"],
    effectLevel: "advisory",
    auditContract: ["Successful watchdog usage event", "Watchdog cadence state and alerts"],
    retryPolicy: ["Cadence state limits analysis frequency", "No durable per-alert retry"],
    costPolicy: { kind: "metered_model", summary: "Watchdog model usage is metered", ledgerFeatures: ["watchdog"] },
    configured: flag("ai_watchdog"),
    runtimeEvidencePredicate: { category: "model_execution", summary: "A fresh successful watchdog model execution exists", evaluate: successfulUsage(["watchdog"]) },
  }),
  contract({
    key: "winback",
    label: "Win-back",
    failureKey: "winback",
    trigger: { kind: "scheduled", summary: "Hourly, candidate- and consent-gated", freshnessHours: 48 },
    permissionContract: ["Requires ai_winback=true", "Permission is re-read before every outbound effect", "Consent and channel gates apply"],
    inputs: ["Eligible inactive customers", "Booking history", "Channel consent and salon rules"],
    outputs: ["One customer SMS or email", "Owner summary"],
    effectLevel: "customer_communication",
    auditContract: ["Only sent_sms or sent_email actions qualify", "Skipped/no-channel actions do not qualify"],
    retryPolicy: ["Hourly rerun", "Customer/action deduplication", "Per-run and learned caps"],
    costPolicy: { kind: "mixed", summary: "Draft model usage plus SMS/email channel cost", ledgerFeatures: ["winback_draft"] },
    configured: flag("ai_winback"),
    runtimeEvidencePredicate: { category: "customer_delivery", summary: "A fresh sent_sms or sent_email audit exists", evaluate: actionTypes("winback", ["sent_sms", "sent_email"]) },
  }),
  contract({
    key: "rebook",
    label: "Rebook",
    failureKey: "rebook",
    trigger: { kind: "scheduled", summary: "Hourly, candidate- and consent-gated", freshnessHours: 48 },
    permissionContract: ["Requires ai_rebook=true", "Permission is re-read before every outbound effect", "Consent and channel gates apply"],
    inputs: ["Eligible completed appointments", "Service timing", "Channel consent and salon rules"],
    outputs: ["One customer SMS or email"],
    effectLevel: "customer_communication",
    auditContract: ["Only sent_sms or sent_email actions qualify", "Skipped/no-channel actions do not qualify"],
    retryPolicy: ["Hourly rerun", "Customer/action deduplication", "Per-run and learned caps"],
    costPolicy: { kind: "mixed", summary: "Draft model usage plus SMS/email channel cost", ledgerFeatures: ["rebook_draft"] },
    configured: flag("ai_rebook"),
    runtimeEvidencePredicate: { category: "customer_delivery", summary: "A fresh sent_sms or sent_email audit exists", evaluate: actionTypes("rebook", ["sent_sms", "sent_email"]) },
  }),
  contract({
    key: "digest",
    label: "Unified Digest",
    failureKey: "digest",
    trigger: { kind: "scheduled", summary: "Daily at 21:00 salon local time", freshnessHours: 72 },
    permissionContract: ["Requires ai_unified_digest=true", "Tenant must be eligible for autonomous AI"],
    inputs: ["Daily booking stats", "Agent actions", "Alerts", "Outcomes", "Pending approvals"],
    outputs: ["One consolidated owner digest"],
    effectLevel: "advisory",
    auditContract: ["Atomic digest delivery record", "ai_actions_log action_type=digest_sent only after provider acceptance"],
    retryPolicy: ["Provider idempotency key", "Unique salon/local-date delivery", "Safe replay inside the 21:00 window"],
    costPolicy: { kind: "metered_model", summary: "Sonnet when needed; deterministic quiet-day fallback is $0", ledgerFeatures: ["digest"] },
    configured: flag("ai_unified_digest"),
    runtimeEvidencePredicate: { category: "provider_delivery", summary: "A fresh provider-acknowledged digest_sent audit exists", evaluate: actionTypes("digest", ["digest_sent"]) },
  }),
  contract({
    key: "social_content",
    label: "Social Content",
    failureKey: "social_content",
    trigger: { kind: "scheduled", summary: "Monday, Wednesday, and Friday at 08:00", freshnessHours: 168 },
    permissionContract: ["Requires ai_social_content=true", "Draft-only; never posts automatically"],
    inputs: ["Recent bookings", "Top services", "Salon trend context"],
    outputs: ["Editable social-content draft"],
    effectLevel: "draft",
    auditContract: ["ai_actions_log action_type=sent_social_draft", "AI usage ledger"],
    retryPolicy: ["Per-week action deduplication", "No automatic post retry"],
    costPolicy: { kind: "metered_model", summary: "Haiku with deterministic fallback", ledgerFeatures: ["social_content"] },
    configured: flag("ai_social_content"),
    runtimeEvidencePredicate: { category: "action_audit", summary: "A fresh sent_social_draft artifact exists", evaluate: actionTypes("social_content", ["sent_social_draft"]) },
  }),
  contract({
    key: "vip_care",
    label: "VIP Care",
    failureKey: "vip_care",
    trigger: { kind: "condition", summary: "Daily at 08:00 for eligible birthday, milestone, or inactive VIP guests", freshnessHours: 72 },
    permissionContract: ["Requires ai_vip_care=true", "Permission is re-read before send", "Consent, channel, reward, and cap gates apply"],
    inputs: ["Customer profile", "Booking/spend history", "Birthday and milestone eligibility", "Consent"],
    outputs: ["Customer SMS/email", "Optional admin-configured voucher", "Owner summary"],
    effectLevel: "customer_communication",
    auditContract: ["Only birthday, milestone_*, or vip_inactive actions qualify", "Skipped/no-channel actions do not qualify"],
    retryPolicy: ["Daily eligibility rerun", "Customer/event deduplication", "Per-run and learned caps"],
    costPolicy: { kind: "mixed", summary: "Draft model usage plus channel cost", ledgerFeatures: ["vip_care_draft"] },
    configured: flag("ai_vip_care"),
    runtimeEvidencePredicate: {
      category: "customer_delivery",
      summary: "A fresh birthday, milestone, or inactive-VIP send audit exists",
      evaluate: actionMatcher("vip_care", (type) => type === "birthday" || type === "vip_inactive" || /^milestone_\d+$/.test(type)),
    },
  }),
  contract({
    key: "strategist",
    label: "Strategist",
    failureKey: "strategist",
    trigger: { kind: "scheduled", summary: "Sunday at 21:00 salon local time", freshnessHours: 336 },
    permissionContract: ["Tenant must be eligible for autonomous AI", "Drafts only; outward actions require approval"],
    inputs: ["Four weeks of bookings", "Service mix", "Capacity", "Retention signals"],
    outputs: ["Recommendation drafts", "Structural escalation", "Optional approval request"],
    effectLevel: "draft",
    auditContract: ["Only draft_* or escalate_structural actions qualify", "Owner-preference suppression is not success evidence"],
    retryPolicy: ["Weekly deduplication", "Approval requests use their own expiry/deduplication"],
    costPolicy: { kind: "metered_model", summary: "Sonnet analysis is metered", ledgerFeatures: ["strategist"] },
    configured: always,
    runtimeEvidencePredicate: {
      category: "action_audit",
      summary: "A fresh recommendation draft or structural escalation exists",
      evaluate: actionMatcher("strategist", (type) => type === "escalate_structural" || type.startsWith("draft_")),
    },
  }),
  contract({
    key: "review_responder",
    label: "Google Review Responder",
    failureKey: "review_responder",
    trigger: { kind: "scheduled", summary: "Every four hours when new Google reviews exist", freshnessHours: 48 },
    permissionContract: ["Requires ai_google_reply=true and Google Place ID", "Draft-only; never posts automatically"],
    inputs: ["New Google reviews", "Rating", "Review language", "Salon identity"],
    outputs: ["Editable reply draft or negative-review escalation"],
    effectLevel: "draft",
    auditContract: ["Only draft_review_reply or escalate_review_reply actions qualify"],
    retryPolicy: ["Review timestamp deduplication", "Provider fetch failures do not have a durable retry record"],
    costPolicy: { kind: "metered_model", summary: "Sonnet reply drafting is metered", ledgerFeatures: ["review_responder"] },
    configured: (salon) => salon.feature_flags?.ai_google_reply === true && Boolean(salon.google_place_id),
    runtimeEvidencePredicate: { category: "action_audit", summary: "A fresh Google review draft/escalation audit exists", evaluate: actionTypes("review_responder", ["draft_review_reply", "escalate_review_reply"]) },
  }),
  contract({
    key: "yelp_responder",
    label: "Yelp Responder",
    failureKey: "yelp_responder",
    trigger: { kind: "scheduled", summary: "Every four hours when new Yelp reviews exist", freshnessHours: 48 },
    permissionContract: ["Requires ai_yelp_reply=true and Yelp business ID", "Draft-only; never posts automatically"],
    inputs: ["New Yelp reviews", "Rating", "Review language", "Salon identity"],
    outputs: ["Editable reply draft or negative-review escalation"],
    effectLevel: "draft",
    auditContract: ["Only sent_reply_draft or escalated_negative_review actions qualify"],
    retryPolicy: ["Review ID deduplication", "Provider fetch failures do not have a durable retry record"],
    costPolicy: { kind: "metered_model", summary: "Haiku reply drafting is metered", ledgerFeatures: ["yelp_responder"] },
    configured: (salon) => salon.feature_flags?.ai_yelp_reply === true && Boolean(salon.yelp_business_id),
    runtimeEvidencePredicate: { category: "action_audit", summary: "A fresh Yelp draft/escalation audit exists", evaluate: actionTypes("yelp_responder", ["sent_reply_draft", "escalated_negative_review"]) },
  }),
  contract({
    key: "gbp_post",
    label: "Google Business Post",
    failureKey: "gbp_post",
    trigger: { kind: "scheduled", summary: "1st and 15th of each month at 10:00", freshnessHours: 504 },
    permissionContract: ["Requires ai_gbp_post=true and Google Place ID", "Draft-only; never posts automatically"],
    inputs: ["Monthly bookings", "Top service", "Salon identity"],
    outputs: ["Editable Google Business Profile post draft"],
    effectLevel: "draft",
    auditContract: ["ai_actions_log action_type=sent_gbp_draft"],
    retryPolicy: ["Half-month action deduplication", "No automatic post retry"],
    costPolicy: { kind: "metered_model", summary: "Haiku with deterministic fallback", ledgerFeatures: ["gbp_post"] },
    configured: (salon) => salon.feature_flags?.ai_gbp_post === true && Boolean(salon.google_place_id),
    runtimeEvidencePredicate: { category: "action_audit", summary: "A fresh sent_gbp_draft artifact exists", evaluate: actionTypes("gbp_post", ["sent_gbp_draft"]) },
  }),
  contract({
    key: "first_visit",
    label: "First Visit Nurture",
    failureKey: "first_visit",
    trigger: { kind: "condition", summary: "Daily; same-day, day-7, and day-14 sequence steps", freshnessHours: 72 },
    permissionContract: ["Requires ai_first_visit_nurture=true", "Permission is re-read before send", "Consent and channel gates apply"],
    inputs: ["Completed first visit", "Service and staff context", "Sequence state", "Consent"],
    outputs: ["Customer warmth/rebook SMS or email"],
    effectLevel: "customer_communication",
    auditContract: ["Only warmth_sent or stepN_sent actions qualify", "Sequence state records due steps"],
    retryPolicy: ["Daily due-step evaluation", "Sequence and conversion deduplication", "Per-run cap"],
    costPolicy: { kind: "mixed", summary: "Draft model usage plus channel cost", ledgerFeatures: ["first_visit_draft"] },
    configured: flag("ai_first_visit_nurture"),
    runtimeEvidencePredicate: { category: "customer_delivery", summary: "A fresh warmth_sent or stepN_sent audit exists", evaluate: actionMatcher("first_visit", (type) => type === "warmth_sent" || /^step\d+_sent$/.test(type)) },
  }),
  contract({
    key: "smart_reminders",
    label: "Smart Reminders",
    failureKey: "smart_reminders",
    trigger: { kind: "condition", summary: "Every 15 minutes for due 24-hour and 3-hour reminders", freshnessHours: 48 },
    permissionContract: ["Requires ai_smart_reminders=true", "Permission is re-read before drafting", "Reminder/channel/A2P/consent gates apply"],
    inputs: ["Due booking", "No-show risk score", "Locale", "Service and salon context"],
    outputs: ["AI-personalized lead inside deterministic reminder SMS; fixed fallback is allowed"],
    effectLevel: "customer_communication",
    auditContract: ["Successful smart_reminder model usage is observable", "No booking/run correlation currently links that usage to the accepted outbound reminder"],
    retryPolicy: ["15-minute cron window", "Booking sent-marker only after at least one successful channel"],
    costPolicy: { kind: "mixed", summary: "Haiku draft plus SMS/email channel cost; fixed fallback is $0 model cost", ledgerFeatures: ["smart_reminder"] },
    configured: flag("ai_smart_reminders"),
    runtimeEvidencePredicate: { category: "unavailable", summary: "Current telemetry cannot correlate a specific model execution to its outbound reminder; do not certify from timestamps alone", evaluate: noRuntimeEvidence },
  }),
  contract({
    key: "ai_execution",
    label: "AI Execution",
    failureKey: "ai_execution",
    trigger: { kind: "scheduled", summary: "Every five minutes for approved queued jobs", freshnessHours: 24 },
    permissionContract: ["Requires ai_control_center_enabled=true", "Only approved requests are queued", "Effect allowlist currently permits internal operational notes only"],
    inputs: ["Approved request", "Execution payload", "Tenant eligibility and lease state"],
    outputs: ["Durable internal operational note or explicit unsupported/waiting result"],
    effectLevel: "internal_write",
    auditContract: ["ai_execution_jobs status=succeeded", "Lease-safe execution events and idempotency key"],
    retryPolicy: ["Durable attempts with backoff", "Lease recovery", "Idempotent job claim"],
    costPolicy: { kind: "deterministic", summary: "Current allowed operational-note effect uses no model", ledgerFeatures: [] },
    configured: flag("ai_control_center_enabled"),
    runtimeEvidencePredicate: { category: "durable_job", summary: "A fresh durable succeeded execution job exists", evaluate: (input, salon) => input.jobs.filter((row) => row.salon_id === salon.id && row.status === "succeeded") },
  }),
  contract({
    key: "voice_ai",
    label: "AI Receptionist",
    failureKey: "voice_ai",
    trigger: { kind: "event", summary: "Inbound phone or web voice session", freshnessHours: 720 },
    permissionContract: ["Requires voice_ai_enabled=true", "Twilio signature or session capability", "Quota/rate limits", "OTP before booking mutations when caller identity is not trusted"],
    inputs: ["Salon context", "Realtime audio/text", "Verified identity state", "Tool inputs"],
    outputs: ["Realtime answer", "Audited tool calls", "Optional verified booking operation"],
    effectLevel: "booking_operation",
    auditContract: ["Completed voice_ai_session", "Model, schemaVersion=1 usage, and estimated_cost_usd", "Separate tool_log"],
    retryPolicy: ["Session renewal capability", "Tool-specific rate limits and idempotency", "Stale active sessions become failures"],
    costPolicy: { kind: "mixed", summary: "Realtime model cost is estimated from schema-v1 usage; telephony cost is external", ledgerFeatures: ["voice_ai"] },
    configured: (salon) => salon.voice_ai_enabled === true,
    runtimeEvidencePredicate: { category: "session_telemetry", summary: "A fresh completed session has model, schema-v1 usage, and cost", evaluate: completeVoiceTelemetry },
  }),
  contract({
    key: "minh_self_learn",
    label: "Minh Self-learning",
    failureKey: "minh_self_learn",
    trigger: { kind: "scheduled", summary: "Daily at 03:00 UTC", freshnessHours: 72 },
    permissionContract: ["CRON_SECRET required", "Runs only for tenant-eligible salons with at least one ai_* flag enabled"],
    inputs: ["7-day channel failures", "30-day agent outcomes", "Channel cost summary", "Pending approval maintenance"],
    outputs: ["Channel lessons", "Outcome pace adaptations", "Approval expiry/reminders", "Cost summary"],
    effectLevel: "internal_write",
    auditContract: ["Per-salon ai_actions_log action_type=lesson_created or outcome_adaptation_activated/recovered", "Global minh_learn worker health alone does not certify each tenant"],
    retryPolicy: ["Tracked daily cron run", "Failed run remains visible; next scheduled run retries"],
    costPolicy: { kind: "deterministic", summary: "Rule-based analysis; no model call in the learning loop", ledgerFeatures: [] },
    configured: anyAiFlag,
    runtimeEvidencePredicate: {
      category: "action_audit",
      summary: "A fresh tenant-scoped lesson or outcome-adaptation audit exists",
      evaluate: actionTypes("minh_self_learn", [
        "lesson_created",
        "outcome_adaptation_activated",
        "outcome_adaptation_recovered",
      ]),
    },
  }),
  contract({
    key: "minh_late_decline",
    label: "Late Group Decline Assistant",
    failureKey: "minh_late_decline",
    trigger: { kind: "event", summary: "Group member reports a late decline", freshnessHours: 720 },
    permissionContract: ["Requires Group Booking release feature", "Future appointment only", "Test-salon SMS guard applies"],
    inputs: ["Group booking and declined member", "Suggested replacement", "Top waiting-list entry"],
    outputs: ["Replacement or wait-list SMS", "Late-decline handling audit"],
    effectLevel: "customer_communication",
    auditContract: ["minh_late_decline late_decline_handled payload must contain sms_suggested:ok or sms_waitlist:ok"],
    retryPolicy: ["Booking-level action deduplication", "No durable retry after a failed send"],
    costPolicy: { kind: "channel_only", summary: "No model call; SMS channel cost may apply", ledgerFeatures: [] },
    configured: releaseFeature("group_booking"),
    runtimeEvidencePredicate: { category: "customer_delivery", summary: "A fresh late-decline audit confirms at least one SMS send", evaluate: lateDeclineDelivery },
  }),
  contract({
    key: "sms_receptionist",
    label: "SMS Receptionist",
    failureKey: "sms_receptionist",
    trigger: { kind: "event", summary: "Inbound Twilio SMS webhook", freshnessHours: 720 },
    permissionContract: ["Valid Twilio signature required", "Requires voice_ai_enabled=true", "Untrusted From number requires OTP before booking mutation"],
    inputs: ["Inbound SMS", "Salon context", "Bounded conversation history", "Shared receptionist tools"],
    outputs: ["SMS reply", "Optional OTP-verified booking operation"],
    effectLevel: "booking_operation",
    auditContract: ["AI usage and sms_agent_sessions exist", "No provider-accepted outbound receipt currently links the full turn"],
    retryPolicy: ["Twilio may retry inbound webhook", "Conversation state is upserted", "No durable outbound retry contract"],
    costPolicy: { kind: "mixed", summary: "Anthropic model usage plus SMS channel cost", ledgerFeatures: ["sms_receptionist"] },
    configured: (salon) => salon.voice_ai_enabled === true,
    runtimeEvidencePredicate: { category: "unavailable", summary: "Current telemetry cannot prove the complete model-to-outbound turn; do not certify from model usage alone", evaluate: noRuntimeEvidence },
  }),
  contract({
    key: "booking_chat",
    label: "Public Booking Chat",
    failureKey: "booking_chat",
    trigger: { kind: "event", summary: "Customer message in the public booking assistant", freshnessHours: 720 },
    permissionContract: ["Public Booking release feature must be enabled", "Read-only salon/service context", "Assistant directs customers to the validated booking form"],
    inputs: ["Last 10 bounded chat messages", "Salon hours, services, prices, and public profile"],
    outputs: ["Short bilingual advisory response"],
    effectLevel: "advisory",
    auditContract: ["Successful booking_chat usage event"],
    retryPolicy: ["Interactive caller may retry", "No durable conversation retry"],
    costPolicy: { kind: "metered_model", summary: "Haiku streaming usage is metered", ledgerFeatures: ["booking_chat"] },
    configured: releaseFeature("public_booking"),
    runtimeEvidencePredicate: { category: "model_execution", summary: "A fresh successful booking_chat model execution exists", evaluate: successfulUsage(["booking_chat"]) },
  }),
  contract({
    key: "admin_copilot",
    label: "Admin Copilot (Coco)",
    failureKey: "admin_copilot",
    trigger: { kind: "event", summary: "Authenticated Owner/Admin/Receptionist asks Coco", freshnessHours: 720 },
    permissionContract: ["Admin Copilot release feature must be enabled", "Authenticated salon membership and role check", "Per-user rate limit", "Tools guide/read or prepare a user-confirmed proposal"],
    inputs: ["Bounded conversation", "User role and current path", "Live salon context", "SOP knowledge"],
    outputs: ["Role-aware guidance", "Deep links", "Optional appointment proposal requiring explicit confirmation"],
    effectLevel: "advisory",
    auditContract: ["Successful admin_copilot usage event", "Existing booking confirmation path owns any mutation"],
    retryPolicy: ["Interactive caller may retry", "Maximum four tool-loop steps", "Per-user rate limit"],
    costPolicy: { kind: "metered_model", summary: "Haiku tool-loop usage is metered", ledgerFeatures: ["admin_copilot"] },
    configured: releaseFeature("admin_copilot"),
    runtimeEvidencePredicate: { category: "model_execution", summary: "A fresh successful admin_copilot model execution exists", evaluate: successfulUsage(["admin_copilot"]) },
  }),
] as const satisfies readonly AgentCertificationDefinition[];

export type AgentCertificationKey =
  (typeof AGENT_CERTIFICATION_REGISTRY)[number]["key"];
