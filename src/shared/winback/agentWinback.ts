import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { sendSmsReminder } from "@/shared/lib/twilioSms";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { sendOwnerAlert } from "@/shared/ai/sendOwnerAlert";
import { resolveCustomerChannel, type CustomerChannelMode } from "@/shared/lib/channelResolver";

/**
 * AI Win-back — find lapsed regulars and draft a warm, personalised "we miss
 * you" message for the owner to review (and later send). Same spine as the other
 * agents: gather (DB, salon-scoped via the winback_candidates RPC) → AI drafts →
 * guard → log to winback_suggestions. The AI only SUGGESTS; sending stays
 * owner-decided, so a wrong draft costs nothing.
 */

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => (v == null ? 0 : Number(v));

export type WinbackCandidate = {
  phone: string;
  name: string;
  email: string | null;
  visits: number;
  lastVisit: string;
  noShows: number;
  usualService: string | null;
};

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!client) client = new Anthropic({ apiKey: key });
  return client;
}

/** Lapsed regulars not already suggested in the last 30 days. */
export async function gatherWinbackCandidates(
  salonId: string,
  limit: number,
): Promise<WinbackCandidate[]> {
  const db = looseServiceClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (db as any).rpc("winback_candidates", {
    p_salon_id: salonId,
    p_min_visits: 2,
    p_lapse_days: 45,
    p_max_days: 365,
    p_limit: limit * 4, // over-fetch; we filter out recently-suggested below
  });
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) return [];

  // Exclude phones suggested in the last 30 days (don't pester).
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const { data: recent } = await db
    .from("winback_suggestions")
    .select("client_phone")
    .eq("salon_id", salonId)
    .gte("created_at", since);
  const suggested = new Set(((recent ?? []) as Row[]).map((r) => str(r.client_phone)));

  const out: WinbackCandidate[] = [];
  for (const r of rows) {
    const phone = str(r.client_phone);
    if (suggested.has(phone)) continue;
    out.push({
      phone,
      name: str(r.client_name) || "there",
      email: str(r.client_email) || null,
      visits: num(r.visits),
      lastVisit: str(r.last_visit),
      noShows: num(r.no_shows),
      usualService: str(r.usual_service) || null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** ① AI BRAIN — draft a warm win-back message. Returns null on failure. */
export async function agentDraftWinback(
  c: WinbackCandidate,
  salonName: string,
  lang: "en" | "vi",
): Promise<string | null> {
  const ai = getClient();
  if (!ai) return null;

  const weeks = Math.max(1, Math.round((Date.now() - Date.parse(c.lastVisit)) / (7 * 864e5)));
  const langLabel = lang === "vi" ? "tiếng Việt" : "English";
  const serviceHint = c.usualService
    ? ` They usually get "${c.usualService}".`
    : "";
  const prompt = `Write a short, warm, genuine win-back message in ${langLabel} for a salon customer who hasn't been in for a while. Make them feel remembered, not sold to.

Customer: ${c.name}, visited ${c.visits} times before, last visit about ${weeks} weeks ago.${serviceHint}
Salon: ${salonName}.

Rules: 1-2 sentences, friendly + personal, mention the salon by name, if a service is given naturally reference it (e.g. "ready for your next Hi-Lite Royal?"), gently invite them to come back, NO emojis, NO links (those are added when sent). Return ONLY the message text, nothing else.`;

  try {
    const resp = await ai.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    const clean = text.replace(/^["']|["']$/g, "").trim();
    return clean.length > 0 && clean.length <= 480 ? clean : null;
  } catch {
    return null;
  }
}

const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";

async function sendWinbackSms(
  phone: string,
  message: string,
  bookingUrl: string,
): Promise<boolean> {
  const body = `${message}\n${bookingUrl}`;
  const r = await sendSmsReminder(phone, body, { lang: "en" });
  return r.ok;
}

async function sendWinbackEmail(
  toEmail: string,
  clientName: string,
  salonName: string,
  message: string,
  bookingUrl: string,
  salonReplyEmail?: string | null,
): Promise<boolean> {
  const resend = getResendClient();
  if (!resend) return false;
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));
  const html = `<div style="max-width:480px;margin:0 auto;font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a">
  <p style="font-size:15px;line-height:1.7;margin:0 0 16px">${esc(message)}</p>
  <a href="${bookingUrl}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px">Book now</a>
  <p style="font-size:12px;color:#999;margin-top:20px">${esc(salonName)}</p>
</div>`;
  const { error } = await resend.emails.send({
    from: getResendFrom(),
    to: toEmail,
    subject: `${salonName} — we'd love to see you again`,
    html,
    text: `${message}\n\n${bookingUrl}\n\n${salonName}`,
    ...(salonReplyEmail ? { replyTo: salonReplyEmail } : {}),
  });
  return !error;
}

/**
 * Run win-back for one salon: opt-in (feature_flags.ai_winback), sends up to
 * `cap` messages per call with ACT+UNDO (60-min window). Logs to ai_actions_log.
 * 30-day dedupe means it goes quiet once the lapsed list is covered.
 */
export async function runWinback(salonId: string, cap = 3): Promise<void> {
  try {
    const db = looseServiceClient();
    const { data: salon } = await db
      .from("salons")
      .select("name, email, feature_flags, slug, sms_outbound_enabled, sms_a2p_registered, email_outbound_enabled, customer_channel" as never)
      .eq("id", salonId)
      .maybeSingle();
    const s = (salon as Row | null) ?? {};
    if ((s.feature_flags as Record<string, unknown> | null)?.ai_winback !== true) return;
    const salonName = str(s.name) || "our salon";
    const salonSlug = str(s.slug) || "";
    const salonReplyEmail = str(s.email) || null;
    const bookingUrl = `${SITE_URL}/${salonSlug}?ref=winback`;
    const smsOutboundEnabled = s.sms_outbound_enabled !== false; // default true (non-US salons work without A2P)
    const smsA2pRegistered = s.sms_a2p_registered === true; // US A2P 10DLC status
    const emailOutboundEnabled = s.email_outbound_enabled !== false; // default true
    const customerChannelMode = (str(s.customer_channel) || "smart") as CustomerChannelMode;

    const candidates = await gatherWinbackCandidates(salonId, cap);
    if (candidates.length === 0) return;

    const svc = createServiceRoleClient();
    let sentCount = 0;

    for (const c of candidates) {
      // Resolve channel BEFORE drafting — no point spending AI tokens on a
      // message that can't be delivered.
      const ch = resolveCustomerChannel({
        mode: customerChannelMode,
        smsOutboundEnabled,
        emailOutboundEnabled,
        customerEmail: c.email,
        smsA2pRegistered,
        customerPhone: c.phone,
      });

      if (ch.noChannel) {
        console.warn(
          `[runWinback] no channel for ${c.name} (${c.phone}) — reason: ${ch.reason}. Add email or complete A2P.`,
        );
        void svc.from("ai_actions_log" as never).insert({
          salon_id: salonId,
          agent: "winback",
          action_type: "skipped_no_channel",
          target_id: null,
          payload: { name: c.name, phone: c.phone, reason: ch.reason },
          undo_deadline: null,
        } as never);
        continue;
      }

      const lang: "en" | "vi" = "en";
      const message = await agentDraftWinback(c, salonName, lang);
      if (!message) continue;

      // Derive a single canonical channel for logging (prefer email to record deliverability).
      const channel: "sms" | "email" = ch.email ? "email" : "sms";

      // Send to customer first; only log if successful.
      let ok = false;
      if (ch.sms) {
        ok = await sendWinbackSms(c.phone, message, bookingUrl);
      }
      if (ch.email && c.email) {
        const emailOk = await sendWinbackEmail(c.email, c.name, salonName, message, bookingUrl, salonReplyEmail);
        // Count as delivered if at least one channel succeeded.
        ok = ok || emailOk;
      }

      if (!ok) continue;
      sentCount++;

      // Persist suggestion as "sent"
      const { data: inserted } = await svc
        .from("winback_suggestions" as never)
        .insert({
          salon_id: salonId,
          client_phone: c.phone,
          client_name: c.name,
          client_email: c.email,
          last_visit: c.lastVisit,
          visit_count: c.visits,
          lang,
          channel,
          message,
          status: "sent",
        } as never)
        .select("id")
        .single();

      const suggestionId = (inserted as { id?: string } | null)?.id ?? null;

      // Audit trail with undo window
      await svc.from("ai_actions_log" as never).insert({
        salon_id: salonId,
        agent: "winback",
        action_type: `sent_${channel}`,
        target_id: suggestionId,
        payload: { name: c.name, channel, reason: ch.reason, message_preview: message.slice(0, 120) },
        undo_deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      } as never);
    }

    if (sentCount > 0) {
      void sendOwnerAlert(salonId, {
        subject: `${salonName} — AI sent ${sentCount} win-back message${sentCount > 1 ? "s" : ""}`,
        bodyText:
          `AI Manager gửi ${sentCount} tin nhắn giữ khách. ` +
          `Bạn có 60 phút để undo từ Activity feed nếu cần.`,
      });
    }
  } catch (e) {
    console.error("[runWinback]", e);
  }
}
