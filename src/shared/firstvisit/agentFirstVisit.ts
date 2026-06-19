import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { sendSmsReminder } from "@/shared/lib/twilioSms";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { resolveCustomerChannel, type CustomerChannelMode } from "@/shared/lib/channelResolver";
import { sendOwnerAlert } from "@/shared/ai/sendOwnerAlert";

/**
 * "Lần ghé đầu → chắc chắn có lần 2"
 *
 * The highest-ROI retention moment: 80% of first-time clients never return.
 * This agent intercepts that window with a 3-step sequence:
 *   Step 0 (same day):  Pure warmth — "Hope you loved it" — NO booking push
 *   Step 1 (day 7):     Soft check-in + booking link
 *   Step 2 (day 14):    Gentle final nudge (service-timing-aware)
 *
 * Stops the moment the client books again. Service-aware cadence: nails = 14d,
 * head spa = 21d, color = 42d — never chases faster than the service interval.
 */

const str = (v: unknown) => (v == null ? "" : String(v));
const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";

let _ai: Anthropic | null = null;
function getAI(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!_ai) _ai = new Anthropic({ apiKey: key });
  return _ai;
}

// How long until the client is "due" based on their service type.
function serviceIntervalDays(service: string | null): number {
  const s = (service ?? "").toLowerCase();
  if (/color|highlight|royal|balayage|bleach/.test(s)) return 42;
  if (/head.?spa|scalp|treatment|facial|massage/.test(s)) return 21;
  if (/nail|mani|pedi|gel|acrylic|dip/.test(s)) return 14;
  return 21;
}

// Day offsets for each nurture step, capped to the service interval.
function stepDays(service: string | null): [number, number] {
  const interval = serviceIntervalDays(service);
  const step1 = Math.min(7, Math.floor(interval * 0.4));
  const step2 = Math.min(14, Math.floor(interval * 0.7));
  return [step1, step2];
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─── AI drafts ────────────────────────────────────────────────────────────────

type DraftContext = {
  step: 0 | 1 | 2;
  clientName: string;
  salonName: string;
  service: string | null;
  lang: "en" | "vi";
  bookingUrl: string;
};

async function draftMessage(ctx: DraftContext): Promise<string | null> {
  const ai = getAI();
  const svc = ctx.service ? `"${ctx.service}"` : "their first service";

  const prompts: Record<0 | 1 | 2, string> = {
    0: `Write a single warm, genuine "thank you for visiting" message in ${ctx.lang === "vi" ? "tiếng Việt" : "English"} for a brand-new first-time salon client.

Client: ${ctx.clientName}, just had ${svc} at ${ctx.salonName}.

Rules: 1 sentence only. Pure warmth — make them feel welcome and seen. Do NOT mention rebooking, links, or promotions. NO emojis. Return ONLY the message text.`,

    1: `Write a short, natural follow-up message in ${ctx.lang === "vi" ? "tiếng Việt" : "English"} for a first-time salon client, sent about a week after their first visit.

Client: ${ctx.clientName}, had ${svc} at ${ctx.salonName} last week.

Rules: 1-2 sentences. Check in warmly on how the service is holding up. Gently mention booking their next visit is easy — do NOT paste a URL (that's added automatically). Friendly tone, like a caring person, not a marketing bot. NO emojis. Return ONLY the message text.`,

    2: `Write a final gentle nudge in ${ctx.lang === "vi" ? "tiếng Việt" : "English"} for a first-time salon client who hasn't rebooked yet.

Client: ${ctx.clientName}, had ${svc} at ${ctx.salonName} about two weeks ago.

Rules: 1-2 sentences. Warm, zero pressure. Say you'd love to see them again and it's easy to book — do NOT include URL (added automatically). Last message — make it feel like a caring goodbye if they don't come, not a hard sell. NO emojis. Return ONLY the message text.`,
  };

  if (!ai) {
    // Fallback text when no AI key
    const fallbacks: Record<0 | 1 | 2, string> = {
      0: `Thank you for visiting ${ctx.salonName} today, ${ctx.clientName} — we loved having you!`,
      1: `Hi ${ctx.clientName}, hope you're still loving your ${ctx.service ?? "visit"} from last week! We'd love to have you back at ${ctx.salonName} anytime.`,
      2: `Hi ${ctx.clientName}, it was wonderful having you at ${ctx.salonName}! We'd love to see you again whenever you're ready.`,
    };
    return fallbacks[ctx.step];
  }

  try {
    const resp = await ai.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 160,
      messages: [{ role: "user", content: prompts[ctx.step] }],
    });
    const raw = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    const clean = raw.replace(/^["']|["']$/g, "").trim();
    return clean.length > 0 && clean.length <= 320 ? clean : null;
  } catch {
    return null;
  }
}

// ─── Send helpers ─────────────────────────────────────────────────────────────

async function sendSms(phone: string, text: string, lang: "en" | "vi"): Promise<boolean> {
  const r = await sendSmsReminder(phone, text, { lang });
  return r.ok;
}

async function sendEmail(
  to: string,
  clientName: string,
  salonName: string,
  text: string,
  bookingUrl: string | null,
  replyTo?: string | null,
): Promise<boolean> {
  const resend = getResendClient();
  if (!resend) return false;
  const esc = (s: string) =>
    s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));
  const bookingBtn = bookingUrl
    ? `<a href="${bookingUrl}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;margin-top:16px">Book again</a>`
    : "";
  const html = `<div style="max-width:480px;margin:0 auto;font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a">
  <p style="font-size:15px;line-height:1.7;margin:0 0 8px">${esc(text)}</p>
  ${bookingBtn}
  <p style="font-size:12px;color:#999;margin-top:20px">${esc(salonName)}</p>
</div>`;
  const { error } = await resend.emails.send({
    from: getResendFrom(),
    to,
    subject: `${salonName} — thank you for visiting`,
    html,
    text: bookingUrl ? `${text}\n\n${bookingUrl}` : text,
    ...(replyTo ? { replyTo } : {}),
  });
  return !error;
}

// ─── Detection: find yesterday's completed first-time bookings ─────────────────

async function detectFirstVisits(salonId: string): Promise<
  {
    bookingId: string;
    phone: string;
    name: string;
    email: string | null;
    service: string | null;
    visitDate: string;
  }[]
> {
  const db = looseServiceClient();
  // Same-day window — cron runs at 20:00 salon time, 30 min after close.
  // Detecting today's visits means warmth message arrives the same evening.
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);

  // Completed bookings from today
  const { data: recent } = await db
    .from("bookings")
    .select("id, guest_phone, guest_name, guest_email, service_name, start_time")
    .eq("salon_id", salonId)
    .eq("status", "completed")
    .gte("start_time", `${today}T00:00:00`)
    .lt("start_time", `${tomorrow}T00:00:00`);

  const rows = (recent ?? []) as Row[];
  if (rows.length === 0) return [];

  // Filter to first-time clients: no prior completed bookings
  const svc = createServiceRoleClient();
  const results = [];
  for (const r of rows) {
    const phone = str(r.guest_phone);
    if (!phone) continue;
    const bookingId = str(r.id);

    // Count other completed bookings for this phone at this salon
    const { data: prior } = await svc
      .from("bookings" as never)
      .select("id")
      .eq("salon_id", salonId)
      .eq("guest_phone", phone)
      .eq("status", "completed")
      .neq("id", bookingId)
      .limit(1);

    if ((prior as unknown[] | null)?.length === 0) {
      results.push({
        bookingId,
        phone,
        name: str(r.guest_name) || "there",
        email: str(r.guest_email) || null,
        service: str(r.service_name) || null,
        visitDate: str(r.start_time).slice(0, 10),
      });
    }
  }
  return results;
}

// ─── Check conversion: has the client booked again? ───────────────────────────

async function hasConverted(salonId: string, phone: string, afterDate: string): Promise<string | null> {
  const svc = createServiceRoleClient();
  const { data } = await svc
    .from("bookings" as never)
    .select("id")
    .eq("salon_id", salonId)
    .eq("guest_phone", phone)
    .neq("status", "cancelled")
    .gt("created_at", afterDate)
    .limit(1)
    .maybeSingle();
  return data ? str((data as Row).id) : null;
}

// ─── Main runner ──────────────────────────────────────────────────────────────

export async function runFirstVisitNurture(salonId: string): Promise<void> {
  try {
    const db = looseServiceClient();
    const svc = createServiceRoleClient();

    const { data: salon } = await db
      .from("salons")
      .select("name, email, slug, feature_flags, sms_outbound_enabled, sms_a2p_registered, email_outbound_enabled, customer_channel, timezone" as never)
      .eq("id", salonId)
      .maybeSingle();

    const s = (salon as Row | null) ?? {};
    if ((s.feature_flags as Record<string, unknown> | null)?.ai_first_visit_nurture !== true) return;

    const salonName = str(s.name) || "our salon";
    const salonSlug = str(s.slug) || "";
    const salonReplyEmail = str(s.email) || null;
    const bookingUrl = `${SITE_URL}/${salonSlug}?ref=firstvisit`;
    const smsEnabled = s.sms_outbound_enabled !== false;
    const emailEnabled = s.email_outbound_enabled !== false;
    const smsA2pRegistered = s.sms_a2p_registered === true; // US A2P 10DLC status
    const channelMode = (str(s.customer_channel) || "smart") as CustomerChannelMode;
    const lang: "en" | "vi" = "en";
    const todayYmd = new Date().toISOString().slice(0, 10);

    // ── 1. Detect new first-time visitors and enroll them ──────────────────
    const firstVisitors = await detectFirstVisits(salonId);
    for (const fv of firstVisitors) {
      const ch = resolveCustomerChannel({
        mode: channelMode,
        smsOutboundEnabled: smsEnabled,
        emailOutboundEnabled: emailEnabled,
        customerEmail: fv.email,
        smsA2pRegistered,
        customerPhone: fv.phone,
      });
      if (ch.noChannel) continue;

      const channel: "sms" | "email" = ch.email ? "email" : "sms";
      const [day1, day2] = stepDays(fv.service);

      // Skip if already enrolled (unique constraint on salon_id + client_phone)
      const { error: insertErr } = await svc
        .from("first_visit_sequences" as never)
        .insert({
          salon_id: salonId,
          client_phone: fv.phone,
          client_name: fv.name,
          client_email: fv.email,
          first_booking_id: fv.bookingId,
          first_service: fv.service,
          first_visit_date: fv.visitDate,
          channel,
          status: "active",
          step: 0,
          next_action_date: toYmd(addDays(new Date(fv.visitDate), day1)),
        } as never)
        .select("id")
        .single();

      if (insertErr) continue; // already enrolled

      // Step 0: same-day warmth (send immediately on enroll)
      const warmth = await draftMessage({ step: 0, clientName: fv.name, salonName, service: fv.service, lang, bookingUrl });
      if (!warmth) continue;

      let ok = false;
      if (ch.sms) ok = await sendSms(fv.phone, warmth, lang);
      if (ch.email && fv.email) ok = (await sendEmail(fv.email, fv.name, salonName, warmth, null, salonReplyEmail)) || ok;

      if (ok) {
        await svc.from("ai_actions_log" as never).insert({
          salon_id: salonId,
          agent: "first_visit",
          action_type: "warmth_sent",
          target_id: null,
          payload: { name: fv.name, channel, service: fv.service, message_preview: warmth.slice(0, 120) },
          undo_deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        } as never);
      }
    }

    // ── 2. Process active sequences due today ──────────────────────────────
    const { data: due } = await svc
      .from("first_visit_sequences" as never)
      .select("*")
      .eq("salon_id", salonId)
      .eq("status", "active")
      .lte("next_action_date", todayYmd);

    const sequences = (due ?? []) as Row[];
    let convertedCount = 0;
    let nudgeCount = 0;

    for (const seq of sequences) {
      const seqId = str(seq.id);
      const phone = str(seq.client_phone);
      const name = str(seq.client_name);
      const email = str(seq.client_email) || null;
      const seqService = str(seq.first_service) || null;
      const step = Number(seq.step) as 1 | 2;
      const channel = str(seq.channel) as "sms" | "email";
      const firstVisitDate = str(seq.first_visit_date);

      // Check conversion first — stop the sequence if they booked again
      const convertedId = await hasConverted(salonId, phone, firstVisitDate);
      if (convertedId) {
        await svc
          .from("first_visit_sequences" as never)
          .update({ status: "converted", converted_booking_id: convertedId, next_action_date: null, updated_at: new Date().toISOString() } as never)
          .eq("id", seqId);
        convertedCount++;
        continue;
      }

      // Step 2 is the last — expire after sending
      const isLastStep = step >= 2;
      const [day1, day2] = stepDays(seqService);
      const nextDate = isLastStep
        ? null
        : toYmd(addDays(new Date(firstVisitDate), step === 1 ? day2 : day1));

      const message = await draftMessage({ step, clientName: name, salonName, service: seqService, lang, bookingUrl });
      if (!message) continue;

      const body = step >= 1 ? `${message}\n${bookingUrl}` : message;

      const ch = resolveCustomerChannel({
        mode: channelMode,
        smsOutboundEnabled: smsEnabled,
        emailOutboundEnabled: emailEnabled,
        customerEmail: email,
        smsA2pRegistered,
        customerPhone: phone,
      });
      if (ch.noChannel) continue;

      let ok = false;
      if (ch.sms) ok = await sendSms(phone, body, lang);
      if (ch.email && email) ok = (await sendEmail(email, name, salonName, message, bookingUrl, salonReplyEmail)) || ok;
      if (!ok) continue;

      nudgeCount++;

      await svc
        .from("first_visit_sequences" as never)
        .update({
          step: step + 1,
          status: isLastStep ? "expired" : "active",
          next_action_date: nextDate,
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id", seqId);

      await svc.from("ai_actions_log" as never).insert({
        salon_id: salonId,
        agent: "first_visit",
        action_type: `step${step}_sent`,
        target_id: seqId,
        payload: { name, channel, service: seqService, step, message_preview: message.slice(0, 120) },
        undo_deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      } as never);
    }

    // ── 3. Owner alert (summary, not per-message spam) ─────────────────────
    if (firstVisitors.length > 0 || convertedCount > 0) {
      const parts: string[] = [];
      if (firstVisitors.length > 0)
        parts.push(`${firstVisitors.length} khách mới vào chuỗi chăm sóc lần đầu`);
      if (convertedCount > 0)
        parts.push(`${convertedCount} khách đã đặt lịch lại 🎉`);
      if (nudgeCount > 0)
        parts.push(`${nudgeCount} tin nhắn nhắc nhở gửi đi`);

      void sendOwnerAlert(salonId, {
        subject: `${salonName} — Khách mới: ${convertedCount > 0 ? `${convertedCount} đã quay lại!` : `${firstVisitors.length} đang được chăm sóc`}`,
        bodyText: parts.join(". ") + ".",
      });
    }
  } catch (e) {
    console.error("[runFirstVisitNurture]", e);
  }
}
