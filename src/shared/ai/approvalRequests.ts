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
 *   4. Owner taps button → GET /api/ai/approve?token=... → processDecision().
 *   5. Declined: auto-creates a minh_lessons 'policy' lesson so Minh learns.
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
import { createLesson } from "@/shared/ai/lessonMutations";

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
  decided_at: string | null;
  created_at: string;
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

  // Already decided?
  if (req.status !== "pending") {
    const salon = await getSalonMeta(req.salon_id);
    return {
      ok: false,
      salonSlug: salon?.slug ?? null,
      actionType: req.action_type,
      alreadyDecided: true,
      expired: req.status === "expired",
    };
  }

  // Expired?
  if (new Date(req.expires_at) < new Date()) {
    // Mark expired if not already
    await db
      .from("approval_requests" as never)
      .update({ status: "expired" } as never)
      .eq("id" as never, req.id);

    const salon = await getSalonMeta(req.salon_id);
    return {
      ok: false,
      salonSlug: salon?.slug ?? null,
      actionType: req.action_type,
      alreadyDecided: false,
      expired: true,
    };
  }

  // Apply decision
  await db
    .from("approval_requests" as never)
    .update({
      status: decision,
      decided_at: new Date().toISOString(),
      // decided_by: cannot resolve without auth here — token auth only
    } as never)
    .eq("id" as never, req.id);

  // On decline: create a lesson so Minh learns to propose less often
  if (decision === "declined") {
    try {
      await createLesson({
        salonId: req.salon_id,
        scope: "policy",
        condition: { action_type: req.action_type },
        rule: `owner_declined: Owner declined "${req.action_type}" on ${new Date().toISOString().slice(0, 10)}. Reduce frequency or skip this action type.`,
        source: `decline:${req.id}`,
        confidence: 0.7,
      });
    } catch (e) {
      console.error("[processDecision] createLesson", e);
    }
  }

  const salon = await getSalonMeta(req.salon_id);
  return {
    ok: true,
    salonSlug: salon?.slug ?? null,
    actionType: req.action_type,
    alreadyDecided: false,
    expired: false,
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
export async function getAllApprovals(salonId: string): Promise<ApprovalRow[]> {
  const db = createServiceRoleClient();
  const { data } = await db
    .from("approval_requests" as never)
    .select("*")
    .eq("salon_id" as never, salonId)
    .order("created_at" as never, { ascending: false })
    .limit(100);

  return (data as ApprovalRow[] | null) ?? [];
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
