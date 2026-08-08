import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { isAiAgentPermissionEnabled } from "@/shared/ai/agentPermissionFence";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { sendSmsReminder } from "@/shared/lib/twilioSms";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { listUnsubscribeHeaders, complianceFooterHtml, isEmailSuppressed } from "@/shared/lib/emailCompliance";
import { resolveCustomerChannel, type CustomerChannelMode } from "@/shared/lib/channelResolver";
import { sendOwnerAlert } from "@/shared/ai/sendOwnerAlert";
import {
  applyLearnedAgentCap,
  getLessons,
} from "@/shared/ai/lessons";
import { salonToday, salonDayRangeUtc } from "@/shared/lib/salonTime";
import { trackAnthropicMessage } from "@/shared/ai/usageLedger";
import {
  firstVisitInitialFollowUpStep,
  normalizeFirstVisitFollowUpStep,
} from "@/shared/firstvisit/sequenceProgress";

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
  salonId?: string | null;
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
    0: `Write a single warm, genuine "thank you for visiting" message in English first, then a blank line, then Vietnamese for a brand-new first-time salon client.

Client: ${ctx.clientName}, just had ${svc} at ${ctx.salonName}.

Rules: 1 sentence only. Pure warmth — make them feel welcome and seen. Do NOT mention rebooking, links, or promotions. NO emojis. Return ONLY the message text.`,

    1: `Write a short, natural follow-up message in English first, then a blank line, then Vietnamese for a first-time salon client, sent about a week after their first visit.

Client: ${ctx.clientName}, had ${svc} at ${ctx.salonName} last week.

Rules: 1-2 sentences. Check in warmly on how the service is holding up. Gently mention booking their next visit is easy — do NOT paste a URL (that's added automatically). Friendly tone, like a caring person, not a marketing bot. NO emojis. Return ONLY the message text.`,

    2: `Write a final gentle nudge in English first, then a blank line, then Vietnamese for a first-time salon client who hasn't rebooked yet.

Client: ${ctx.clientName}, had ${svc} at ${ctx.salonName} about two weeks ago.

Rules: 1-2 sentences. Warm, zero pressure. Say you'd love to see them again and it's easy to book — do NOT include URL (added automatically). Last message — make it feel like a caring goodbye if they don't come, not a hard sell. NO emojis. Return ONLY the message text.`,
  };

  if (!ai) {
    // Fallback text when no AI key — bilingual (English first, then Vietnamese).
    const svcName = ctx.service ?? "dịch vụ";
    const fallbacks: Record<0 | 1 | 2, string> = {
      0: `Thank you for visiting ${ctx.salonName} today, ${ctx.clientName} — we loved having you!\n\nCảm ơn ${ctx.clientName} đã ghé ${ctx.salonName} hôm nay — tiệm rất vui được đón bạn!`,
      1: `Hi ${ctx.clientName}, hope you're still loving your ${ctx.service ?? "visit"} from last week! We'd love to have you back at ${ctx.salonName} anytime.\n\nChào ${ctx.clientName}, mong bạn vẫn hài lòng với ${svcName} tuần trước! ${ctx.salonName} luôn mong được đón bạn trở lại.`,
      2: `Hi ${ctx.clientName}, it was wonderful having you at ${ctx.salonName}! We'd love to see you again whenever you're ready.\n\nChào ${ctx.clientName}, thật tuyệt khi được đón bạn tại ${ctx.salonName}! Mong gặp lại bạn bất cứ khi nào bạn sẵn sàng.`,
    };
    return fallbacks[ctx.step];
  }

  try {
    const model = "claude-haiku-4-5-20251001";
    const resp = await trackAnthropicMessage(
      { salonId: ctx.salonId ?? null, feature: "first_visit_draft", model },
      () => ai.messages.create({
        model,
        max_tokens: 320, // bilingual output is ~2x
        messages: [{ role: "user", content: prompts[ctx.step] }],
      }),
    );
    const raw = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    const clean = raw.replace(/^["']|["']$/g, "").trim();
    return clean.length > 0 && clean.length <= 700 ? clean : null;
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
  // First-visit nurture is a marketing sequence — honour suppression list.
  const suppressed = await isEmailSuppressed(to).catch(() => true);
  if (suppressed) return false;
  const esc = (s: string) =>
    s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));
  const bookingBtn = bookingUrl
    ? `<p style="margin:0 0 22px;"><a href="${bookingUrl}" style="display:inline-block;padding:13px 26px;background:#0a0a0a;color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:15px;">Book again</a></p>`
    : "";
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#faf9f7;">
  <div style="max-width:480px;margin:0 auto;padding:28px 22px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#2a2a2a;">
    <p style="margin:0 0 8px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#888;">${esc(salonName)}</p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;">${esc(text)}</p>
    ${bookingBtn}
  </div>
${complianceFooterHtml({ email: to, salonName, lang: "en" })}
</body></html>`;
  const { error } = await resend.emails.send({
    from: getResendFrom(),
    to,
    subject: `${salonName} — thank you for visiting`,
    html,
    text: bookingUrl ? `${text}\n\n${bookingUrl}` : text,
    headers: listUnsubscribeHeaders(to),
    ...(replyTo ? { replyTo } : {}),
  });
  return !error;
}

// ─── Detection: find yesterday's completed first-time bookings ─────────────────

async function detectFirstVisits(salonId: string, tz: string): Promise<
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
  // Same-day window in the SALON timezone — cron runs at 20:00 salon time,
  // 30 min after close. bookings store start_time_utc; the day must be computed
  // salon-local (using the UTC calendar day shifted the window a day forward for
  // North-American salons — 20:00 PT = next-day UTC — and missed the business
  // day that just closed).
  const todayLocal = salonToday(tz);
  const { startUtc, endUtc } = salonDayRangeUtc(todayLocal, tz);

  // Completed bookings from today (salon-local). Columns are client_* /
  // start_time_utc / service via FK — the table never had guest_* / service_name
  // / start_time, so the old query 400'd and silently detected nobody.
  const { data: recent } = await db
    .from("bookings")
    .select("id, client_phone, client_name, client_email, service:service_id(name), start_time_utc")
    .eq("salon_id", salonId)
    .eq("status", "completed")
    .gte("start_time_utc", startUtc)
    .lt("start_time_utc", endUtc);

  const rows = (recent ?? []) as Row[];
  if (rows.length === 0) return [];

  // Filter to first-time clients: no prior completed bookings
  const svc = createServiceRoleClient();
  const results = [];
  for (const r of rows) {
    const phone = str(r.client_phone);
    if (!phone) continue;
    const bookingId = str(r.id);

    // Count other completed bookings for this phone at this salon
    const { data: prior } = await svc
      .from("bookings" as never)
      .select("id")
      .eq("salon_id", salonId)
      .eq("client_phone", phone)
      .eq("status", "completed")
      .neq("id", bookingId)
      .limit(1);

    if ((prior as unknown[] | null)?.length === 0) {
      results.push({
        bookingId,
        phone,
        name: str(r.client_name) || "there",
        email: str(r.client_email) || null,
        service: str((r.service as Record<string, unknown> | null)?.name) || null,
        visitDate: todayLocal,
      });
    }
  }
  return results;
}

// ─── Check conversion: has the client booked again? ───────────────────────────

async function hasConverted(
  salonId: string,
  phone: string,
  afterDate: string,
  excludeBookingId: string,
): Promise<string | null> {
  const svc = createServiceRoleClient();
  const { data } = await svc
    .from("bookings" as never)
    .select("id")
    .eq("salon_id", salonId)
    .eq("client_phone", phone)
    // Exclude the first visit's OWN booking: afterDate is a date-only value
    // (midnight), so a same-day walk-in's own booking (created that afternoon)
    // would otherwise count as a "conversion" and kill its day-7/day-14 nudges.
    .neq("id", excludeBookingId)
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
    const tz = str(s.timezone) || "America/Los_Angeles";
    // Salon-local "today" — drives the `next_action_date <= today` due filter
    // below. Using the UTC day fired scheduled steps a day early for salons
    // behind UTC.
    const todayYmd = salonToday(tz);
    const segmentLessons = await getLessons(salonId, "segment");
    const learnedNudgeCap = applyLearnedAgentCap(
      15,
      segmentLessons,
      "first_visit",
    );

    // ── 1. Detect new first-time visitors and enroll them ──────────────────
    const firstVisitors = await detectFirstVisits(salonId, tz);

    // Channel-scoped consent. Square email-subscription (marketing_email_consent_at)
    // unlocks EMAIL only, never SMS. Gated OFF by default.
    const emailConsentEnabled = process.env.SQUARE_EMAIL_CONSENT_SEND === "1";
    // consentedPhones = reachable at all (email at least); smsConsentPhones = may
    // be TEXTED (full opt-in only). First-visit nurture is marketing — only
    // contact consented customers.
    const allPhones = firstVisitors.map((fv) => fv.phone).filter(Boolean);
    const consentedPhones = new Set<string>();
    const smsConsentPhones = new Set<string>();
    if (allPhones.length > 0) {
      const { data: consentRows } = await svc
        .from("client_profiles" as never)
        .select("phone, marketing_consent_at, marketing_email_consent_at" as never)
        .in("phone" as never, allPhones);
      for (const r of (consentRows ?? []) as unknown as Row[]) {
        const ph = str(r.phone);
        if (!ph) continue;
        const full = !!r.marketing_consent_at;
        const emailOnly = emailConsentEnabled && !!r.marketing_email_consent_at;
        if (full) smsConsentPhones.add(ph);
        if (full || emailOnly) consentedPhones.add(ph);
      }
    }

    for (const fv of firstVisitors) {
      if (
        !(await isAiAgentPermissionEnabled(
          salonId,
          "ai_first_visit_nurture",
        ))
      ) {
        break;
      }

      // Skip customers who haven't opted into marketing communications.
      if (!consentedPhones.has(fv.phone)) continue;

      const ch = resolveCustomerChannel({
        mode: channelMode,
        // SMS only for a full opt-in; email-only-consent → forced to email.
        smsOutboundEnabled: smsEnabled && smsConsentPhones.has(fv.phone),
        emailOutboundEnabled: emailEnabled,
        customerEmail: fv.email,
        smsA2pRegistered,
        customerPhone: fv.phone,
      });
      if (ch.noChannel) continue;

      const channel: "sms" | "email" = ch.email ? "email" : "sms";
      const [day1] = stepDays(fv.service);

      // Skip if already enrolled (unique constraint on salon_id + client_phone)
      const { data: insertedSequence, error: insertErr } = await svc
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
          // Step 0 is the warmth message sent immediately below. The next due
          // action must therefore be step 1, never a second copy of step 0.
          step: firstVisitInitialFollowUpStep(),
          next_action_date: toYmd(addDays(new Date(fv.visitDate), day1)),
        } as never)
        .select("id")
        .single();

      if (insertErr) continue; // already enrolled
      const sequenceId = (insertedSequence as { id?: string } | null)?.id ?? null;

      // Step 0: same-day warmth (send immediately on enroll)
      const warmth = await draftMessage({ salonId, step: 0, clientName: fv.name, salonName, service: fv.service, lang, bookingUrl });
      if (!warmth) continue;

      if (
        !(await isAiAgentPermissionEnabled(
          salonId,
          "ai_first_visit_nurture",
        ))
      ) {
        break;
      }

      let ok = false;
      if (ch.sms) ok = await sendSms(fv.phone, warmth, lang);
      if (ch.email && fv.email) ok = (await sendEmail(fv.email, fv.name, salonName, warmth, null, salonReplyEmail)) || ok;

      if (ok) {
        await svc.from("ai_actions_log" as never).insert({
          salon_id: salonId,
          agent: "first_visit",
          action_type: "warmth_sent",
          // A durable target lets Outcome Tracker recover identity even if an
          // older payload shape did not contain the phone.
          target_id: sequenceId,
          payload: {
            name: fv.name,
            phone: fv.phone,
            channel,
            service: fv.service,
            message_preview: warmth.slice(0, 120),
          },
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
      if (
        !(await isAiAgentPermissionEnabled(
          salonId,
          "ai_first_visit_nurture",
        ))
      ) {
        break;
      }

      const seqId = str(seq.id);
      const phone = str(seq.client_phone);
      const name = str(seq.client_name);
      const email = str(seq.client_email) || null;
      const seqService = str(seq.first_service) || null;
      // Legacy sequences were persisted at step 0 after warmth had already
      // been sent. Normalize them to step 1 instead of repeating warmth.
      const step = normalizeFirstVisitFollowUpStep(seq.step);
      const channel = str(seq.channel) as "sms" | "email";
      const firstVisitDate = str(seq.first_visit_date);

      // Skip if customer revoked consent or never consented (existing sequences
      // pre-date the consent column — check before each send). Channel-scoped:
      // full opt-in → may text; email-only (Square) → email only.
      if (!consentedPhones.has(phone)) {
        const { data: cp } = await svc
          .from("client_profiles" as never)
          .select("marketing_consent_at, marketing_email_consent_at" as never)
          .eq("phone" as never, phone)
          .maybeSingle();
        const cpr = cp as Row | null;
        const full = !!cpr?.marketing_consent_at;
        const emailOnly = emailConsentEnabled && !!cpr?.marketing_email_consent_at;
        if (!full && !emailOnly) continue;
        if (full) smsConsentPhones.add(phone);
        consentedPhones.add(phone); // cache for this run
      }

      // Check conversion first — stop the sequence if they booked again
      const convertedId = await hasConverted(salonId, phone, firstVisitDate, str(seq.first_booking_id));
      if (convertedId) {
        await svc
          .from("first_visit_sequences" as never)
          .update({ status: "converted", converted_booking_id: convertedId, next_action_date: null, updated_at: new Date().toISOString() } as never)
          .eq("id", seqId);
        convertedCount++;
        continue;
      }

      // Keep conversion checks running for every due sequence, but defer extra
      // outreach once the learned daily cap is reached.
      if (nudgeCount >= learnedNudgeCap) continue;

      // Step 2 is the last — expire after sending
      const isLastStep = step >= 2;
      const [day1, day2] = stepDays(seqService);
      const nextDate = isLastStep
        ? null
        : toYmd(addDays(new Date(firstVisitDate), step === 1 ? day2 : day1));

      const message = await draftMessage({ salonId, step, clientName: name, salonName, service: seqService, lang, bookingUrl });
      if (!message) continue;

      const body = step >= 1 ? `${message}\n${bookingUrl}` : message;

      const ch = resolveCustomerChannel({
        mode: channelMode,
        // SMS only for a full opt-in; email-only-consent → forced to email.
        smsOutboundEnabled: smsEnabled && smsConsentPhones.has(phone),
        emailOutboundEnabled: emailEnabled,
        customerEmail: email,
        smsA2pRegistered,
        customerPhone: phone,
      });
      if (ch.noChannel) continue;

      if (
        !(await isAiAgentPermissionEnabled(
          salonId,
          "ai_first_visit_nurture",
        ))
      ) {
        break;
      }

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
        payload: {
          name,
          phone,
          channel,
          service: seqService,
          step,
          message_preview: message.slice(0, 120),
        },
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
    throw e;
  }
}
