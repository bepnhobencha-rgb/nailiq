import "server-only";

/**
 * Minh Approval Requests — §3D + §3E of SPEC-minh-learning-loop.md
 *
 * Gate for expensive / hard-to-reverse actions that Minh wants to take but
 * must NOT execute without owner consent:
 *   - send_us_sms (A2P-unregistered US SMS)
 *   - charge_noshow (auto-charge no-show fee)
 *   - bulk_message (broadcast to many customers)
 *   - price_change (touching pricing / promotions)
 *
 * Workflow:
 *   1. Agent calls createApprovalRequest() instead of acting directly.
 *   2. For urgent requests: email sent immediately with approve/decline buttons.
 *   3. For normal requests: queued; digest includes them; reminders after 24h.
 *   4. Owner opens GET confirmation, then POSTs the form → processDecision().
 *   5. Resolved decisions refresh a bounded owner-preference policy so repeated
 *      declines reduce future proposals and later approvals can recover them.
 *
 * Example usage (see bottom of file for more):
 *   const requestId = await createApprovalRequest({
 *     salonId,
 *     actionType: 'send_us_sms',
 *     summary: `Minh muốn gửi SMS cho 12 khách US (Hi-Lite). Tiệm chưa đăng ký A2P.`,
 *     payload: { recipients, message },
 *     urgency: 'normal',
 *   });
 */

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import type { ExecutionJobStatus } from "@/shared/ai/executionPolicy";
import { refreshOwnerProposalPreference } from "@/shared/ai/ownerPreference";
import {
  buildActionIntelligence,
  type ActionIntelligence,
} from "@/shared/ai/actionIntelligence";

export type ApprovalUrgency = "urgent" | "normal";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ApprovalRow = {
  id: string;
  salon_id: string;
  action_type: string;
  summary: string;
  payload: Record<string, unknown>;
  urgency: ApprovalUrgency;
  status: "pending" | "approved" | "declined" | "expired";
  approve_token: string;
  decline_token: string;
  expires_at: string;
  notified_at: string | null;
  reminded_at: string | null;
  decided_by: string | null;
  decision_channel: "dashboard" | "email_capability" | null;
  decided_at: string | null;
  created_at: string;
};

export type ApprovalDecisionActor = {
  label: string;
  role: "owner" | "admin";
};

export type ApprovalOwnerSourceRow = Pick<
  ApprovalRow,
  | "id"
  | "salon_id"
  | "action_type"
  | "summary"
  | "payload"
  | "urgency"
  | "status"
  | "expires_at"
  | "decided_by"
  | "decision_channel"
  | "decided_at"
  | "created_at"
>;

export type ApprovalDisplayRow = Pick<
  ApprovalOwnerSourceRow,
  | "id"
  | "action_type"
  | "summary"
  | "urgency"
  | "status"
  | "expires_at"
  | "decision_channel"
  | "decided_at"
  | "created_at"
> & {
  decision_actor: ApprovalDecisionActor | null;
  intelligence: Record<"en" | "vi", ActionIntelligence>;
};

const OWNER_APPROVAL_COLUMNS =
  "id,salon_id,action_type,summary,payload,urgency,status,expires_at,decided_by,decision_channel,decided_at,created_at";

function boundedText(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

function boundedActionIntelligence(
  value: ActionIntelligence,
): ActionIntelligence {
  return {
    reason: boundedText(value.reason, 600),
    evidence: value.evidence
      .slice(0, 4)
      .map((item) => boundedText(item, 300))
      .filter(Boolean),
    impact: boundedText(value.impact, 600),
    confidence: value.confidence,
    reversibility: value.reversibility,
  };
}

export function toApprovalDisplayRow(
  row: ApprovalOwnerSourceRow,
  decisionActor: ApprovalDecisionActor | null = null,
): ApprovalDisplayRow {
  return {
    id: row.id,
    action_type: boundedText(row.action_type, 100),
    summary: boundedText(row.summary, 1_000),
    urgency: row.urgency,
    status: row.status,
    expires_at: row.expires_at,
    decision_channel: row.decision_channel,
    decided_at: row.decided_at,
    created_at: row.created_at,
    decision_actor: decisionActor,
    intelligence: {
      en: boundedActionIntelligence(
        buildActionIntelligence(row.action_type, row.payload, "en"),
      ),
      vi: boundedActionIntelligence(
        buildActionIntelligence(row.action_type, row.payload, "vi"),
      ),
    },
  };
}

function approvalActorLabel(user: {
  email?: string | null;
  phone?: string | null;
  user_metadata?: Record<string, unknown> | null;
} | null): string {
  const metadata = user?.user_metadata ?? {};
  for (const key of ["full_name", "display_name", "name"] as const) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (user?.email?.trim()) return user.email.trim();
  if (user?.phone?.trim()) return user.phone.trim();
  return "Authenticated owner/admin";
}

/**
 * Convert server-only approval rows into owner-facing rows without leaking
 * bearer tokens or internal auth user IDs. Dashboard actors are resolved with
 * targeted Auth lookups and must still hold an owner/admin membership for the
 * same salon before their identity is displayed.
 */
export async function toApprovalDisplayRows(
  rows: ApprovalOwnerSourceRow[],
): Promise<ApprovalDisplayRow[]> {
  const dashboardRows = rows.filter(
    (row) => row.decision_channel === "dashboard" && row.decided_by,
  );
  if (dashboardRows.length === 0) return rows.map((row) => toApprovalDisplayRow(row));

  const userIds = [...new Set(dashboardRows.map((row) => row.decided_by!))];
  const salonIds = [...new Set(dashboardRows.map((row) => row.salon_id))];
  const db = createServiceRoleClient();
  const { data: memberships } = await db
    .from("salon_members")
    .select("salon_id, user_id, role")
    .in("salon_id", salonIds)
    .in("user_id", userIds)
    .in("role", ["owner", "admin"]);

  const roleByMembership = new Map<string, ApprovalDecisionActor["role"]>();
  for (const member of (memberships ?? []) as Array<{
    salon_id: string;
    user_id: string;
    role: string;
  }>) {
    if (member.role === "owner" || member.role === "admin") {
      roleByMembership.set(
        `${member.salon_id}:${member.user_id}`,
        member.role,
      );
    }
  }

  const eligibleUserIds = [
    ...new Set(
      dashboardRows
        .filter((row) =>
          roleByMembership.has(`${row.salon_id}:${row.decided_by}`),
        )
        .map((row) => row.decided_by!),
    ),
  ];
  const labels = new Map<string, string>();
  await Promise.all(
    eligibleUserIds.map(async (userId) => {
      const { data, error } = await db.auth.admin.getUserById(userId);
      labels.set(
        userId,
        approvalActorLabel(error ? null : (data.user ?? null)),
      );
    }),
  );

  return rows.map((row) => {
    if (row.decision_channel !== "dashboard" || !row.decided_by) {
      return toApprovalDisplayRow(row);
    }
    const role = roleByMembership.get(`${row.salon_id}:${row.decided_by}`);
    if (!role) return toApprovalDisplayRow(row);
    return toApprovalDisplayRow(row, {
      label: labels.get(row.decided_by) ?? "Authenticated owner/admin",
      role,
    });
  });
}

type ApprovalDecisionTransition = {
  outcome:
    | "approved_queued"
    | "approved_recovered"
    | "declined"
    | "expired"
    | "already_decided"
    | "invalid_decision"
    | "not_found";
  approval_id: string | null;
  salon_id: string | null;
  action_type: string | null;
  decision_status: ApprovalRow["status"] | null;
  execution_job_id: string | null;
  execution_status: ExecutionJobStatus | null;
  decided_at: string | null;
};

type SalonMeta = {
  name: string;
  slug: string;
  timezone: string;
  email: string | null; // salon contact email for replyTo
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getSalonMeta(salonId: string): Promise<SalonMeta | null> {
  const db = createServiceRoleClient();
  const { data } = await db
    .from("salons" as never)
    .select("name, slug, timezone, email")
    .eq("id" as never, salonId)
    .maybeSingle();

  if (!data) return null;
  const s = data as { name?: string; slug?: string; timezone?: string; email?: string | null };
  return {
    name: s.name ?? "our salon",
    slug: s.slug ?? "",
    timezone: s.timezone ?? "America/Los_Angeles",
    email: s.email ?? null,
  };
}

async function resolveOwnerEmails(salonId: string): Promise<string[]> {
  const db = createServiceRoleClient();

  const { data: members } = await db
    .from("salon_members")
    .select("user_id, role")
    .eq("salon_id", salonId)
    .in("role", ["owner", "admin"]);

  const userIds = [
    ...new Set(
      ((members ?? []) as { user_id: string }[])
        .map((m) => m.user_id)
        .filter(Boolean),
    ),
  ];

  const emails = await Promise.all(
    userIds.map(async (uid) => {
      const { data, error } = await db.auth.admin.getUserById(uid);
      return error ? null : (data.user?.email ?? null);
    }),
  );

  return emails.filter((e): e is string => !!e);
}

function formatExpiresAt(expiresAt: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("vi-VN", {
      timeZone: tz,
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(expiresAt));
  } catch {
    return expiresAt;
  }
}

function buildApprovalEmailHtml(params: {
  salonName: string;
  summary: string;
  approveUrl: string;
  declineUrl: string;
  expiresLabel: string;
}): string {
  const { salonName, summary, approveUrl, declineUrl, expiresLabel } = params;
  const esc = (s: string) =>
    s.replace(/[<>&"]/g, (c) =>
      c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : "&quot;",
    );

  return `<div style="max-width:540px;margin:0 auto;font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a;padding:8px">
  <p style="font-size:11px;color:#999;margin:0 0 20px;text-transform:uppercase;letter-spacing:.08em">${esc(salonName)} · Minh cần duyệt</p>
  <p style="font-size:15px;line-height:1.75;margin:0 0 16px">Xin chào,</p>
  <p style="font-size:15px;line-height:1.75;margin:0 0 16px">
    Minh đề xuất hành động sau và cần sự đồng ý của bạn trước khi thực hiện:
  </p>
  <div style="background:#f9f9f9;border-left:4px solid #d4a200;padding:12px 16px;margin:0 0 24px;border-radius:0 8px 8px 0">
    <p style="margin:0;font-size:15px;line-height:1.65">${esc(summary)}</p>
  </div>
  <div style="margin:0 0 24px;display:flex;gap:8px">
    <a href="${approveUrl}" style="background:#16a34a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;margin:4px;font-size:15px;font-weight:600">✓ Đồng ý</a>
    <a href="${declineUrl}" style="background:#dc2626;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;margin:4px;font-size:15px;font-weight:600">✗ Từ chối</a>
  </div>
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
  <p style="font-size:12px;color:#aaa;margin:0">Link có hiệu lực đến: ${esc(expiresLabel)}</p>
  <p style="font-size:12px;color:#aaa;margin:4px 0 0">— Quản Lý AI Minh · ${esc(salonName)}</p>
</div>`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create an approval request and, for urgent actions, immediately notify
 * the owner via email with one-tap approve/decline buttons.
 *
 * Returns the new request id, or null if the insert failed.
 */
export async function createApprovalRequest(params: {
  salonId: string;
  actionType: string;
  summary: string;
  payload: Record<string, unknown>;
  urgency: ApprovalUrgency;
  /** Hours until the request expires. Defaults: urgent=4h, normal=48h. */
  expiresInHours?: number;
}): Promise<string | null> {
  const {
    salonId,
    actionType,
    summary,
    payload,
    urgency,
    expiresInHours,
  } = params;

  const defaultHours = urgency === "urgent" ? 4 : 48;
  const hours = expiresInHours ?? defaultHours;
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  const db = createServiceRoleClient();

  const { data, error } = await db
    .from("approval_requests" as never)
    .insert({
      salon_id: salonId,
      action_type: actionType,
      summary,
      payload,
      urgency,
      expires_at: expiresAt,
    } as never)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[createApprovalRequest] insert", error);
    return null;
  }

  const requestId = (data as { id: string } | null)?.id ?? null;
  if (!requestId) return null;

  // Urgent: notify immediately. Normal: queued until digest.
  if (urgency === "urgent") {
    await sendApprovalEmail(requestId);
  }

  return requestId;
}

/**
 * Send the approval email for a given request.
 * Called directly for urgent requests; called from digest for normal ones.
 * Updates `notified_at` on the row so we don't double-send.
 */
export async function sendApprovalEmail(requestId: string): Promise<boolean> {
  const db = createServiceRoleClient();

  const { data: row, error: fetchErr } = await db
    .from("approval_requests" as never)
    .select("*")
    .eq("id" as never, requestId)
    .maybeSingle();

  if (fetchErr || !row) {
    console.error("[sendApprovalEmail] fetch", requestId, fetchErr);
    return false;
  }

  const req = row as ApprovalRow;

  // Don't re-notify already-notified requests (unless it's the reminder path)
  if (req.notified_at) return true; // already sent

  // Don't email for decided/expired requests
  if (req.status !== "pending") return false;

  const salon = await getSalonMeta(req.salon_id);
  if (!salon) {
    console.error("[sendApprovalEmail] no salon", req.salon_id);
    return false;
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://nailiq.ca";
  const approveUrl = `${appUrl}/api/ai/approve?token=${req.approve_token}`;
  const declineUrl = `${appUrl}/api/ai/approve?token=${req.decline_token}`;
  const expiresLabel = formatExpiresAt(req.expires_at, salon.timezone);

  const html = buildApprovalEmailHtml({
    salonName: salon.name,
    summary: req.summary,
    approveUrl,
    declineUrl,
    expiresLabel,
  });

  const subject = `[Minh cần duyệt] ${req.summary.slice(0, 80)}${req.summary.length > 80 ? "…" : ""}`;
  const textBody = `Xin chào,\n\nMinh đề xuất hành động sau và cần sự đồng ý của bạn:\n\n${req.summary}\n\nĐồng ý: ${approveUrl}\nTừ chối: ${declineUrl}\n\nLink có hiệu lực đến: ${expiresLabel}\n\n— Quản Lý AI Minh · ${salon.name}`;

  const resend = getResendClient();
  if (!resend) {
    console.warn("[sendApprovalEmail] no resend client");
    return false;
  }

  const recipients = await resolveOwnerEmails(req.salon_id);
  if (recipients.length === 0) {
    console.warn("[sendApprovalEmail] no recipients for salon", req.salon_id);
    return false;
  }

  const sendParams: Parameters<typeof resend.emails.send>[0] = {
    from: getResendFrom(),
    to: recipients,
    subject,
    html,
    text: textBody,
  };
  if (salon.email) {
    sendParams.replyTo = salon.email;
  }

  const { error: sendErr } = await resend.emails.send(sendParams);
  if (sendErr) {
    console.error("[sendApprovalEmail] resend", sendErr);
    return false;
  }

  // Mark as notified
  await db
    .from("approval_requests" as never)
    .update({ notified_at: new Date().toISOString() } as never)
    .eq("id" as never, requestId);

  return true;
}

/**
 * Process a one-tap approve/decline from the email link.
 * Looks up approve_token first, then decline_token.
 */
export async function processDecision(
  token: string,
  decision: "approved" | "declined",
): Promise<{
  ok: boolean;
  salonSlug: string | null;
  actionType: string | null;
  alreadyDecided: boolean;
  expired: boolean;
  execution?: {
    ok: boolean;
    jobId: string | null;
    status: ExecutionJobStatus | null;
    error: string | null;
  };
}> {
  const db = createServiceRoleClient();

  // Find request by either token type
  const { data: row } = await db
    .from("approval_requests" as never)
    .select("*")
    .or(
      `approve_token.eq.${token},decline_token.eq.${token}` as never,
    )
    .maybeSingle();

  if (!row) {
    return { ok: false, salonSlug: null, actionType: null, alreadyDecided: false, expired: false };
  }

  const req = row as ApprovalRow;
  const { data: transitionRows, error: transitionError } = await db.rpc(
    "decide_ai_approval_request" as never,
    { p_token: token, p_decision: decision } as never,
  );
  if (transitionError) {
    console.error("[processDecision] atomic decision", transitionError);
    return {
      ok: false,
      salonSlug: null,
      actionType: req.action_type,
      alreadyDecided: false,
      expired: false,
    };
  }

  const transition = (
    transitionRows as ApprovalDecisionTransition[] | null
  )?.[0];
  if (!transition || transition.outcome === "not_found" || transition.outcome === "invalid_decision") {
    return {
      ok: false,
      salonSlug: null,
      actionType: req.action_type,
      alreadyDecided: false,
      expired: false,
    };
  }

  if (transition.outcome === "expired") {
    const salon = await getSalonMeta(req.salon_id);
    return {
      ok: false,
      salonSlug: salon?.slug ?? null,
      actionType: req.action_type,
      alreadyDecided: false,
      expired: true,
    };
  }

  if (transition.outcome === "already_decided") {
    const salon = await getSalonMeta(req.salon_id);
    return {
      ok: false,
      salonSlug: salon?.slug ?? null,
      actionType: req.action_type,
      alreadyDecided: true,
      expired: transition.decision_status === "expired",
    };
  }

  // Feed repeated strategist decisions back into future proposal frequency.
  // This is deliberately advisory: a preference refresh failure must never
  // roll back or reinterpret the owner's persisted approve/decline decision.
  const proposalSource =
    typeof req.payload?.proposal_source === "string"
      ? req.payload.proposal_source
      : null;
  const isNewDecision =
    transition.outcome === "approved_queued" ||
    transition.outcome === "declined";
  if (proposalSource && isNewDecision) {
    try {
      const preference = await refreshOwnerProposalPreference({
        salonId: req.salon_id,
        actionType: req.action_type,
        proposalSource,
      });
      if (preference.changed) {
        await db.from("ai_actions_log" as never).insert({
          salon_id: req.salon_id,
          agent: "strategist",
          action_type: preference.active
            ? "owner_preference_cooldown_activated"
            : "owner_preference_cooldown_recovered",
          target_id: req.id,
          payload: {
            approval_request_id: req.id,
            approval_decision: decision,
            approval_action_type: req.action_type,
            proposal_source: proposalSource,
            lesson_id: preference.lessonId,
          },
        } as never);
      }
    } catch (e) {
      console.error("[processDecision] owner preference", e);
    }
  }

  const execution =
    decision === "approved"
      ? {
          ok: true,
          jobId: transition.execution_job_id,
          status: transition.execution_status,
          error: null,
        }
      : undefined;

  const salon = await getSalonMeta(req.salon_id);
  return {
    ok: true,
    salonSlug: salon?.slug ?? null,
    actionType: req.action_type,
    alreadyDecided: false,
    expired: false,
    execution,
  };
}

/**
 * Cron helper: mark expired requests + send a single reminder for requests
 * that were notified 24h+ ago but not yet reminded.
 *
 * Called from /api/cron/minh-learn.
 */
export async function processExpiredAndRemind(): Promise<{
  expired: number;
  reminded: number;
}> {
  const db = createServiceRoleClient();
  const now = new Date().toISOString();

  // 1. Mark pending + past expires_at as expired
  const { data: expiredRows } = await db
    .from("approval_requests" as never)
    .update({ status: "expired" } as never)
    .eq("status" as never, "pending")
    .lt("expires_at" as never, now)
    .select("id");

  const expired = (expiredRows as { id: string }[] | null)?.length ?? 0;

  // 2. Find pending requests notified 24h+ ago but never reminded
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: remindRows } = await db
    .from("approval_requests" as never)
    .select("*")
    .eq("status" as never, "pending")
    .is("reminded_at" as never, null)
    .not("notified_at" as never, "is", null)
    .lt("notified_at" as never, cutoff24h);

  const toRemind = (remindRows as ApprovalRow[] | null) ?? [];
  let reminded = 0;

  for (const req of toRemind) {
    try {
      const sent = await sendReminderEmail(req);
      if (sent) {
        await db
          .from("approval_requests" as never)
          .update({ reminded_at: new Date().toISOString() } as never)
          .eq("id" as never, req.id);
        reminded++;
      }
    } catch (e) {
      console.error("[processExpiredAndRemind] remind", req.id, e);
    }
  }

  return { expired, reminded };
}

/**
 * Send a reminder email for a still-pending request (called at most once per request).
 */
async function sendReminderEmail(req: ApprovalRow): Promise<boolean> {
  const salon = await getSalonMeta(req.salon_id);
  if (!salon) return false;

  const resend = getResendClient();
  if (!resend) return false;

  const recipients = await resolveOwnerEmails(req.salon_id);
  if (recipients.length === 0) return false;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://nailiq.ca";
  const approveUrl = `${appUrl}/api/ai/approve?token=${req.approve_token}`;
  const declineUrl = `${appUrl}/api/ai/approve?token=${req.decline_token}`;
  const expiresLabel = formatExpiresAt(req.expires_at, salon.timezone);

  const html = buildApprovalEmailHtml({
    salonName: salon.name,
    summary: `[Nhắc lại] ${req.summary}`,
    approveUrl,
    declineUrl,
    expiresLabel,
  });

  const subject = `[Nhắc lại — Minh cần duyệt] ${req.summary.slice(0, 70)}${req.summary.length > 70 ? "…" : ""}`;
  const textBody = `[Nhắc lại]\n\nMinh vẫn đang chờ quyết định của bạn:\n\n${req.summary}\n\nĐồng ý: ${approveUrl}\nTừ chối: ${declineUrl}\n\nLink hết hạn: ${expiresLabel}\n\n— Quản Lý AI Minh · ${salon.name}`;

  const sendParams: Parameters<typeof resend.emails.send>[0] = {
    from: getResendFrom(),
    to: recipients,
    subject,
    html,
    text: textBody,
  };
  if (salon.email) sendParams.replyTo = salon.email;

  const { error } = await resend.emails.send(sendParams);
  if (error) {
    console.error("[sendReminderEmail] resend", error);
    return false;
  }
  return true;
}

/**
 * Query helper: get pending approval requests for a salon (used by digest + dashboard).
 */
export async function getPendingApprovals(salonId: string): Promise<ApprovalRow[]> {
  const db = createServiceRoleClient();
  const { data } = await db
    .from("approval_requests" as never)
    .select("*")
    .eq("salon_id" as never, salonId)
    .eq("status" as never, "pending")
    .order("created_at" as never, { ascending: false });

  return (data as ApprovalRow[] | null) ?? [];
}

/**
 * Query helper: get all approvals for a salon (used by the dashboard page).
 */
export async function getAllApprovals(
  salonId: string,
): Promise<ApprovalOwnerSourceRow[]> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("approval_requests" as never)
    .select(OWNER_APPROVAL_COLUMNS as never)
    .eq("salon_id" as never, salonId)
    .order("created_at" as never, { ascending: false })
    .limit(100);

  if (error) {
    throw new Error("approval_requests_read_failed", { cause: error });
  }
  return (data as unknown as ApprovalOwnerSourceRow[] | null) ?? [];
}

export type ApprovalInboxSnapshot = {
  items: ApprovalOwnerSourceRow[];
  pendingCount: number;
};

/**
 * Owner-facing Control Center snapshot.
 *
 * The row list includes pending requests plus recent decisions and is
 * deliberately bounded for rendering. The pending badge uses an independent
 * exact count so a busy salon never sees "100" when more decisions are waiting.
 */
export async function getApprovalInboxSnapshot(
  salonId: string,
): Promise<ApprovalInboxSnapshot> {
  const db = createServiceRoleClient();
  const [itemsResult, countResult] = await Promise.all([
    db
      .from("approval_requests" as never)
      .select(OWNER_APPROVAL_COLUMNS as never)
      .eq("salon_id" as never, salonId)
      .order("created_at" as never, { ascending: false })
      .limit(100),
    db
      .from("approval_requests" as never)
      .select("id", { count: "exact", head: true })
      .eq("salon_id" as never, salonId)
      .eq("status" as never, "pending"),
  ]);
  if (itemsResult.error || countResult.error) {
    throw new Error("approval_inbox_read_failed", {
      cause: itemsResult.error ?? countResult.error,
    });
  }
  if (countResult.count == null) {
    throw new Error("pending_approval_count_unavailable");
  }
  return {
    items:
      (itemsResult.data as unknown as ApprovalOwnerSourceRow[] | null) ?? [],
    pendingCount: countResult.count,
  };
}

/*
 * ─── EXAMPLE USAGE ────────────────────────────────────────────────────────────
 *
 * Instead of acting directly on an expensive / hard-to-reverse action:
 *
 *   // ❌ Don't do this for A2P-unregistered US salons:
 *   await sendSmsToUsCustomer({ phone, message });
 *
 *   // ✅ Do this instead — Minh queues + notifies owner, then waits:
 *   const requestId = await createApprovalRequest({
 *     salonId,
 *     actionType: 'send_us_sms',
 *     summary: `Minh muốn gửi SMS cho ${count} khách US (${salonName}). Tiệm chưa đăng ký A2P — cần xác nhận của bạn để tiếp tục.`,
 *     payload: { recipients, message },
 *     urgency: 'normal',
 *   });
 *
 *   // For charge actions:
 *   await createApprovalRequest({
 *     salonId,
 *     actionType: 'charge_noshow',
 *     summary: `Minh muốn tính phí no-show $${(amountCents/100).toFixed(2)} cho ${clientName}.`,
 *     payload: { bookingId, amountCents, squareCustomerId },
 *     urgency: 'urgent',  // financial — notify immediately
 *   });
 */
