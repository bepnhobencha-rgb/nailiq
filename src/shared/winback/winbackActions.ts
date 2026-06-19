"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { sendSmsReminder } from "@/shared/lib/twilioSms";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";

const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";

export type WinbackSuggestion = {
  id: string;
  kind: "lapsed" | "due";
  client_phone: string;
  client_name: string;
  client_email: string | null;
  channel: "sms" | "email";
  message: string;
  last_visit: string;
  visit_count: number;
  created_at: string;
};

/** Load pending (status='suggested') drafts for the salon. Owner/admin only. */
export async function loadWinbackSuggestions(
  slug: string,
): Promise<{ ok: true; items: WinbackSuggestion[] } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "unauthorized" };

  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("winback_suggestions" as never)
    .select("id, kind, client_phone, client_name, client_email, channel, message, last_visit, visit_count, created_at")
    .eq("salon_id", ctx.salon.id)
    .eq("status", "suggested")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return { ok: false, error: String(error.message) };
  return { ok: true, items: (data ?? []) as WinbackSuggestion[] };
}

/** Approve a pending draft: send the message, mark 'sent', log undo window. */
export async function approveWinbackSuggestion(
  slug: string,
  id: string,
  editedMessage?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "unauthorized" };

  const db = createServiceRoleClient();

  // Atomic status guard — only act on 'suggested' rows.
  const { data: row, error: fetchErr } = await db
    .from("winback_suggestions" as never)
    .select("id, kind, client_phone, client_name, client_email, channel, message, lang")
    .eq("id", id)
    .eq("salon_id", ctx.salon.id)
    .eq("status", "suggested")
    .maybeSingle();

  if (fetchErr || !row) return { ok: false, error: "Suggestion not found or already actioned." };
  const r = row as Row;

  const salonSlug = ctx.salon.slug ?? slug;
  const salonName = ctx.salon.name ?? "our salon";
  const kind = String(r.kind ?? "lapsed") as "lapsed" | "due";
  const ref = kind === "due" ? "rebook" : "winback";
  const bookingUrl = `${SITE_URL}/${salonSlug}?ref=${ref}`;

  const message = editedMessage?.trim() || String(r.message);
  const channel = String(r.channel) as "sms" | "email";
  const phone = String(r.client_phone);
  const email = r.client_email ? String(r.client_email) : null;
  const name = String(r.client_name);
  const lang = (String(r.lang ?? "en")) as "en" | "vi";

  // Fetch salon reply email for email sends
  const { data: salonRow } = await looseServiceClient()
    .from("salons")
    .select("email" as never)
    .eq("id", ctx.salon.id)
    .maybeSingle();
  const salonReplyEmail = (salonRow as Row | null)?.email ? String((salonRow as Row).email) : null;

  let ok = false;

  if (channel === "sms") {
    const res = await sendSmsReminder(phone, `${message}\n${bookingUrl}`, { lang });
    ok = res.ok;
  } else if (channel === "email" && email) {
    const resend = getResendClient();
    if (resend) {
      const esc = (s: string) =>
        s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));
      const subject =
        kind === "due"
          ? `Time for your next visit at ${salonName}`
          : `${salonName} — we'd love to see you again`;
      const html = `<div style="max-width:480px;margin:0 auto;font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a">
  <p style="font-size:15px;line-height:1.7;margin:0 0 16px">${esc(message)}</p>
  <a href="${bookingUrl}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px">Book now</a>
  <p style="font-size:12px;color:#999;margin-top:20px">${esc(salonName)}</p>
</div>`;
      const { error: sendErr } = await resend.emails.send({
        from: getResendFrom(),
        to: email,
        subject,
        html,
        text: `${message}\n\n${bookingUrl}`,
        ...(salonReplyEmail ? { replyTo: salonReplyEmail } : {}),
      });
      ok = !sendErr;
    }
  }

  if (!ok) return { ok: false, error: "Delivery failed — check SMS/email config." };

  // Mark sent
  await db
    .from("winback_suggestions" as never)
    .update({ status: "sent", sent_at: new Date().toISOString(), message } as never)
    .eq("id", id)
    .eq("status", "suggested");

  // Audit log with 60-min undo
  await db.from("ai_actions_log" as never).insert({
    salon_id: ctx.salon.id,
    agent: kind === "due" ? "rebook" : "winback",
    action_type: `sent_${channel}`,
    target_id: id,
    payload: { name, channel, message_preview: message.slice(0, 120), approved_by: ctx.role },
    undo_deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  } as never);

  return { ok: true };
}

/** Dismiss a pending draft without sending. */
export async function dismissWinbackSuggestion(
  slug: string,
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "unauthorized" };

  const db = createServiceRoleClient();
  const { error } = await db
    .from("winback_suggestions" as never)
    .update({ status: "dismissed", dismissed_at: new Date().toISOString() } as never)
    .eq("id", id)
    .eq("salon_id", ctx.salon.id)
    .eq("status", "suggested");

  if (error) return { ok: false, error: String(error.message) };
  return { ok: true };
}
