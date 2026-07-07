import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { sendSmsReminder } from "@/shared/lib/twilioSms";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { sendOwnerAlert } from "@/shared/ai/sendOwnerAlert";
import { resolveCustomerChannel, type CustomerChannelMode } from "@/shared/lib/channelResolver";

/**
 * AI VIP Care — proactive outreach to high-value customers.
 *
 * Three triggers (checked daily at salon hour 8):
 *   birthday     — 7 days before date_of_birth; once per calendar year
 *   milestone    — at 10 / 25 / 50 completed visits; once per milestone
 *   vip_inactive — VIP client silent 30+ days; once per 30-day window
 *
 * All actions logged to ai_actions_log with a 60-min undo window.
 * Gate: feature_flags.ai_vip_care = true
 */

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => (v == null ? 0 : Number(v));

let anthropic: Anthropic | null = null;
function getAI(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!anthropic) anthropic = new Anthropic({ apiKey: key });
  return anthropic;
}

type VipClient = {
  id: string;
  phone: string;
  name: string;
  email: string | null;
  dateOfBirth: string | null; // ISO date string "YYYY-MM-DD"
  isVip: boolean;
  visitCount: number; // completed bookings at THIS salon
  lastVisitAt: string | null; // ISO timestamp
  marketingConsentAt: string | null; // full opt-in (SMS + email)
  marketingEmailConsentAt: string | null; // email-only (e.g. Square subscriber)
};

async function loadVipClients(salonId: string): Promise<VipClient[]> {
  const db = looseServiceClient();

  // Base: clients who have spend records at this salon (5+ visits OR $100+ OR manually VIP)
  const { data: spendRows } = await (db as ReturnType<typeof looseServiceClient>)
    .from("salon_client_spend" as never)
    .select("client_profile_id, total_spend_cents, payment_count" as never)
    .eq("salon_id" as never, salonId);

  const spendSet = new Map<string, Row>(
    ((spendRows ?? []) as Row[]).map((r) => [str(r.client_profile_id), r]),
  );

  // Manually-flagged VIPs who might not be in spend table yet
  const { data: manualVips } = await (db as ReturnType<typeof looseServiceClient>)
    .from("client_profiles" as never)
    .select("id" as never)
    .eq("is_vip" as never, true);
  for (const r of (manualVips ?? []) as Row[]) {
    if (!spendSet.has(str(r.id))) spendSet.set(str(r.id), r);
  }

  if (spendSet.size === 0) return [];

  const ids = Array.from(spendSet.keys());

  // Load profile details
  const { data: profiles } = await (db as ReturnType<typeof looseServiceClient>)
    .from("client_profiles" as never)
    .select("id, phone, name, email, date_of_birth, is_vip, marketing_consent_at, marketing_email_consent_at" as never)
    .in("id" as never, ids);

  if (!profiles?.length) return [];

  // Count completed bookings per client at this salon. Track each visit day
  // too, so Square-imported visits below can be merged without double-counting
  // a NailIQ booking that was also paid through Square (same-day overlap).
  const { data: bookingCounts } = await (db as ReturnType<typeof looseServiceClient>)
    .from("bookings" as never)
    .select("client_profile_id, start_time_utc" as never)
    .eq("salon_id" as never, salonId)
    .eq("status" as never, "completed")
    .in("client_profile_id" as never, ids);

  const visitCountMap = new Map<string, number>();
  const bookingDayMap = new Map<string, Set<string>>();
  for (const b of (bookingCounts ?? []) as Row[]) {
    const cid = str(b.client_profile_id);
    visitCountMap.set(cid, (visitCountMap.get(cid) ?? 0) + 1);
    const day = str(b.start_time_utc).slice(0, 10);
    if (day) {
      if (!bookingDayMap.has(cid)) bookingDayMap.set(cid, new Set());
      bookingDayMap.get(cid)!.add(day);
    }
  }

  // Merge Square-imported paid visits. For salons migrated from Square the
  // historical (and ongoing POS) visit ledger lives in square_visit_history,
  // NOT in bookings — so imported clients otherwise look like 0-visit / never-
  // seen and the milestone / win-back triggers never fire. Count only Square
  // visit-days with no matching completed booking that day (avoids double count
  // for the overlap set). Salons without any Square rows are unaffected.
  const { data: squareVisits } = await (db as ReturnType<typeof looseServiceClient>)
    .from("square_visit_history" as never)
    .select("client_profile_id, visit_date" as never)
    .eq("salon_id" as never, salonId)
    .in("client_profile_id" as never, ids);

  const squareDayMap = new Map<string, Set<string>>();
  const squareLastMap = new Map<string, string>();
  for (const v of (squareVisits ?? []) as Row[]) {
    const cid = str(v.client_profile_id);
    const day = str(v.visit_date).slice(0, 10);
    if (!cid || !day) continue;
    if (!squareDayMap.has(cid)) squareDayMap.set(cid, new Set());
    squareDayMap.get(cid)!.add(day);
    const prev = squareLastMap.get(cid);
    if (!prev || day > prev) squareLastMap.set(cid, day);
  }
  for (const [cid, days] of squareDayMap) {
    const bookingDays = bookingDayMap.get(cid);
    let extra = 0;
    for (const d of days) if (!bookingDays || !bookingDays.has(d)) extra += 1;
    if (extra > 0) visitCountMap.set(cid, (visitCountMap.get(cid) ?? 0) + extra);
  }

  // Latest booking per client
  const { data: latestRows } = await (db as ReturnType<typeof looseServiceClient>)
    .from("bookings" as never)
    .select("client_profile_id, start_time_utc" as never)
    .eq("salon_id" as never, salonId)
    .in("client_profile_id" as never, ids)
    .order("start_time_utc" as never, { ascending: false });

  const lastVisitMap = new Map<string, string>();
  for (const b of (latestRows ?? []) as Row[]) {
    const cid = str(b.client_profile_id);
    if (!lastVisitMap.has(cid)) lastVisitMap.set(cid, str(b.start_time_utc));
  }
  // Fold in Square last-visit dates — imported clients have no booking rows,
  // and even booked clients may have a more recent Square-only payment.
  for (const [cid, day] of squareLastMap) {
    const existing = lastVisitMap.get(cid);
    if (!existing || day > existing.slice(0, 10)) lastVisitMap.set(cid, day);
  }

  const out: VipClient[] = [];
  for (const p of (profiles as Row[])) {
    const id = str(p.id);
    const spend = spendSet.get(id);
    const visits = visitCountMap.get(id) ?? 0;
    const spendCents = num(spend?.total_spend_cents);
    const paymentCount = num(spend?.payment_count);

    // Include if: manually VIP OR $100+ spend OR 5+ visit records
    if (!p.is_vip && spendCents < 10000 && paymentCount < 5 && visits < 3) continue;

    out.push({
      id,
      phone: str(p.phone),
      name: str(p.name) || "there",
      email: str(p.email) || null,
      dateOfBirth: p.date_of_birth ? str(p.date_of_birth) : null,
      isVip: Boolean(p.is_vip),
      visitCount: visits,
      lastVisitAt: lastVisitMap.get(id) ?? null,
      marketingConsentAt: p.marketing_consent_at ? str(p.marketing_consent_at) : null,
      marketingEmailConsentAt: p.marketing_email_consent_at ? str(p.marketing_email_consent_at) : null,
    });
  }
  return out;
}

// Check which ai_actions_log entries already exist for this salon's vip_care agent
async function loadExistingActions(salonId: string): Promise<Set<string>> {
  const db = createServiceRoleClient();
  const since = new Date(Date.now() - 366 * 864e5).toISOString(); // last year
  const { data } = await db
    .from("ai_actions_log" as never)
    .select("action_type, target_id, created_at" as never)
    .eq("salon_id" as never, salonId)
    .eq("agent" as never, "vip_care")
    .gte("created_at" as never, since);

  const keys = new Set<string>();
  const yearStart = `${new Date().getUTCFullYear()}-01-01T00:00:00.000Z`;
  const thirtyAgo = new Date(Date.now() - 30 * 864e5).toISOString();

  for (const row of (data ?? []) as unknown as Row[]) {
    const type = str(row.action_type);
    const tid = str(row.target_id);
    const at = str(row.created_at);

    if (type.startsWith("milestone_")) {
      // Milestones are one-time; any entry blocks forever
      keys.add(`${type}:${tid}`);
    } else if (type === "birthday" && at >= yearStart) {
      // Birthday once per calendar year
      keys.add(`birthday:${tid}`);
    } else if (type === "vip_inactive" && at >= thirtyAgo) {
      // Inactive nudge at most once per 30 days
      keys.add(`vip_inactive:${tid}`);
    }
  }
  return keys;
}

// Days until next occurrence of a month/day birthday (0..365)
function daysUntilBirthday(dob: string): number {
  const now = new Date();
  const thisYear = now.getUTCFullYear();
  const [, mm, dd] = dob.split("-").map(Number);
  const next = new Date(Date.UTC(thisYear, mm - 1, dd));
  if (next.getTime() < now.getTime()) next.setUTCFullYear(thisYear + 1);
  return Math.round((next.getTime() - now.getTime()) / 864e5);
}

type MessageType = "birthday" | "milestone" | "vip_inactive";

async function draftMessage(
  type: MessageType,
  client: VipClient,
  salonName: string,
  visitCount?: number,
): Promise<string> {
  const ai = getAI();
  if (!ai) {
    // Fallback plain text — bilingual (English first, then Vietnamese).
    if (type === "birthday")
      return `Hi ${client.name}, your birthday is coming up — we'd love to celebrate with you at ${salonName}! Book a special visit:\n\nChào ${client.name}, sinh nhật bạn sắp tới rồi — ${salonName} rất mong được cùng bạn ăn mừng! Đặt một buổi đặc biệt nhé:`;
    if (type === "milestone")
      return `Hi ${client.name}, you've hit visit #${visitCount} at ${salonName} — thank you so much! As a token of our appreciation:\n\nChào ${client.name}, bạn đã ghé ${salonName} lần thứ ${visitCount} — cảm ơn bạn rất nhiều! Một chút tri ân từ tiệm:`;
    return `Hi ${client.name}, we've been thinking of you! It's been a little while — we'd love to see you again at ${salonName}:\n\nChào ${client.name}, tiệm nhớ bạn lắm! Đã lâu chưa gặp — ${salonName} mong được đón bạn trở lại:`;
  }

  // Bilingual output: Vietnamese first, then a blank line, then English.
  const bilingual =
    "Write it in English FIRST, then a blank line, then the Vietnamese version. No emojis, no links (added separately). Return ONLY the two-language message text.";
  let prompt: string;
  if (type === "birthday") {
    prompt = `Write a warm, brief birthday message (1-2 sentences) for a VIP salon customer whose birthday is coming up in about a week. Customer name: ${client.name}. Salon: ${salonName}. Be personal and caring — invite them to celebrate with a visit. ${bilingual}`;
  } else if (type === "milestone") {
    prompt = `Write a short, genuine thank-you message (1-2 sentences) for a loyal VIP salon customer celebrating their ${visitCount}th visit. Customer name: ${client.name}. Salon: ${salonName}. Express authentic gratitude and make them feel valued. ${bilingual}`;
  } else {
    prompt = `Write a warm, brief "we miss you" message (1-2 sentences) for a VIP salon customer who hasn't visited in about a month. Customer name: ${client.name}. Salon: ${salonName}. Make it feel caring, not pushy — gently invite them back. ${bilingual}`;
  }

  try {
    const resp = await ai.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400, // bilingual output is ~2x
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    const clean = text.replace(/^["']|["']$/g, "").trim();
    return clean.length > 10 && clean.length <= 900
      ? clean
      : `Hi ${client.name}, thinking of you at ${salonName}!\n\nChào ${client.name}, tiệm luôn nhớ bạn tại ${salonName}!`;
  } catch {
    return `Chào ${client.name}, tiệm luôn nhớ bạn tại ${salonName}!\n\nHi ${client.name}, thinking of you at ${salonName}!`;
  }
}

async function sendMessage(
  client: VipClient,
  message: string,
  bookingUrl: string,
  channelMode: CustomerChannelMode,
  smsOutboundEnabled: boolean,
  emailOutboundEnabled: boolean,
  salonReplyEmail?: string | null,
  smsA2pRegistered?: boolean,
): Promise<{ ok: boolean; channel: "sms" | "email"; reason: string }> {
  const ch = resolveCustomerChannel({
    mode: channelMode,
    smsOutboundEnabled,
    emailOutboundEnabled,
    customerEmail: client.email,
    smsA2pRegistered,
    customerPhone: client.phone,
  });

  if (ch.noChannel) {
    return { ok: false, channel: "sms", reason: ch.reason };
  }

  const fullText = `${message}\n${bookingUrl}`;
  let ok = false;

  if (ch.sms) {
    const r = await sendSmsReminder(client.phone, fullText, { lang: "en" });
    ok = r.ok;
  }
  if (ch.email && client.email) {
    const resend = getResendClient();
    if (resend) {
      const esc = (x: string) =>
        x.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));
      const html = `<div style="max-width:480px;margin:0 auto;font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a"><p style="font-size:15px;line-height:1.7;margin:0 0 16px">${esc(message)}</p><a href="${bookingUrl}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px">Book now</a></div>`;
      const { error } = await resend.emails.send({
        from: getResendFrom(),
        to: client.email,
        subject: message.slice(0, 80),
        html,
        text: fullText,
        ...(salonReplyEmail ? { replyTo: salonReplyEmail } : {}),
      });
      ok = ok || !error;
    }
  }

  const channel: "sms" | "email" = ch.email ? "email" : "sms";
  return { ok, channel, reason: ch.reason };
}

type RewardCfg = { type: string; percent: number; amountCents: number; validDays: number };

/** Issue an admin-configured care voucher (birthday or milestone) for this
 *  client and return the line to append to the message. Returns null when no
 *  reward is configured OR it couldn't be created — never promise a gift we
 *  didn't make. `code` must be deterministic (once-per-occasion) so a re-issue
 *  is a harmless duplicate. */
async function issueCareVoucher(
  svc: ReturnType<typeof createServiceRoleClient>,
  salonId: string,
  client: VipClient,
  cfg: RewardCfg,
  opts: { voucherKind: "birthday" | "milestone"; code: string; giftPhraseVi: string; giftPhraseEn: string },
): Promise<{ rewardLine: string } | null> {
  if (cfg.type === "percent" ? !(cfg.percent > 0) : cfg.type === "amount" ? !(cfg.amountCents > 0) : true) {
    return null;
  }
  const now = new Date();
  const expires = new Date(now.getTime() + cfg.validDays * 864e5);
  const row: Record<string, unknown> = {
    salon_id: salonId,
    code: opts.code,
    kind: opts.voucherKind,
    max_uses: 1,
    valid_from: now.toISOString(),
    expires_at: expires.toISOString(),
    client_phone: client.phone,
    client_profile_id: client.id,
  };
  if (cfg.type === "percent") row.percent_off = cfg.percent;
  else row.amount_off_cents = cfg.amountCents;

  const { error } = await svc.from("vouchers" as never).insert(row as never);
  const isDup = error && /duplicate|unique/i.test(String(error.message ?? error));
  if (error && !isDup) {
    console.error("[runVipCare] care voucher insert failed", opts.voucherKind, error);
    return null;
  }
  const labelVi = cfg.type === "percent"
    ? `giảm ${cfg.percent}%`
    : `giảm $${Math.round(cfg.amountCents / 100)}`;
  const labelEn = cfg.type === "percent"
    ? `${cfg.percent}% off`
    : `$${Math.round(cfg.amountCents / 100)} off`;
  return {
    rewardLine:
      `🎁 ${opts.giftPhraseEn}: ${labelEn} your next visit — code ${opts.code} (valid ${cfg.validDays} days).\n` +
      `${opts.giftPhraseVi}: ${labelVi} cho lần ghé tới — mã ${opts.code} (dùng trong ${cfg.validDays} ngày).`,
  };
}

/** last-4 of phone (fallback to profile id) for a deterministic voucher code. */
function clientCodeToken(client: VipClient): string {
  return client.phone.replace(/\D/g, "").slice(-4) || client.id.slice(0, 4);
}

export async function runVipCare(salonId: string): Promise<void> {
  try {
    const db = looseServiceClient();
    const { data: salon } = await db
      .from("salons" as never)
      .select("name, email, slug, feature_flags, sms_outbound_enabled, sms_a2p_registered, email_outbound_enabled, customer_channel, birthday_reward_type, birthday_reward_percent, birthday_reward_amount_cents, birthday_reward_valid_days, milestone_reward_type, milestone_reward_percent, milestone_reward_amount_cents, milestone_reward_valid_days" as never)
      .eq("id" as never, salonId)
      .maybeSingle();

    const s = (salon as Row | null) ?? {};
    const flags = (s.feature_flags as Record<string, unknown> | null) ?? {};
    if (flags.ai_vip_care !== true) return;

    const salonName = str(s.name) || "our salon";
    const salonSlug = str(s.slug) || "";
    const salonReplyEmail = str(s.email) || null;
    const smsOutboundEnabled = s.sms_outbound_enabled !== false; // default true
    const emailOutboundEnabled = s.email_outbound_enabled !== false; // default true
    const smsA2pRegistered = s.sms_a2p_registered === true; // US A2P 10DLC status
    const customerChannelMode = (str(s.customer_channel) || "smart") as CustomerChannelMode;
    const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
    const bookingUrl = `${SITE_URL}/${salonSlug}?ref=vip`;
    // Admin-configured care gifts (default 'none' → no reward attached).
    const birthdayReward: RewardCfg = {
      type: str(s.birthday_reward_type) || "none",
      percent: num(s.birthday_reward_percent),
      amountCents: num(s.birthday_reward_amount_cents),
      validDays: num(s.birthday_reward_valid_days) || 30,
    };
    const milestoneReward: RewardCfg = {
      type: str(s.milestone_reward_type) || "none",
      percent: num(s.milestone_reward_percent),
      amountCents: num(s.milestone_reward_amount_cents),
      validDays: num(s.milestone_reward_valid_days) || 30,
    };

    const [clients, existing] = await Promise.all([
      loadVipClients(salonId),
      loadExistingActions(salonId),
    ]);

    if (clients.length === 0) return;

    const svc = createServiceRoleClient();
    const MILESTONES = [10, 25, 50];
    // Anti-blast cap. This agent had never actually run (it queried a
    // non-existent `start_time` column and silently no-op'd), so its dedupe log
    // is empty — the first successful run would otherwise message EVERY
    // currently-qualifying VIP at once (e.g. all VIPs inactive 30–60 days).
    // Cap sends per salon per run so the backlog drains over several daily runs
    // instead of blasting real customers in one pass; steady-state daily volume
    // is well under this.
    const MAX_SENDS_PER_RUN = 15;
    // Channel-scoped consent: Square email-subscription (marketing_email_consent_at)
    // unlocks EMAIL only, never SMS. Gated OFF by default until deliberately enabled.
    const emailConsentEnabled = process.env.SQUARE_EMAIL_CONSENT_SEND === "1";
    let sentCount = 0;

    for (const client of clients) {
      if (sentCount >= MAX_SENDS_PER_RUN) break;
      // Full opt-in → SMS or email. Email-only consent (Square) → EMAIL ONLY.
      const hasFullConsent = !!client.marketingConsentAt;
      const hasEmailConsent =
        hasFullConsent || (emailConsentEnabled && !!client.marketingEmailConsentAt);
      if (!hasEmailConsent) continue;
      // Only a full opt-in permits a text; email-only consent forces email.
      const clientSmsEnabled = smsOutboundEnabled && hasFullConsent;

      // ── Birthday (7 days out) ─────────────────────────────────
      if (client.dateOfBirth && !existing.has(`birthday:${client.id}`)) {
        const days = daysUntilBirthday(client.dateOfBirth);
        if (days === 7) {
          const baseMsg = await draftMessage("birthday", client, salonName);
          // Attach the admin-configured birthday gift (a real voucher code), if any.
          const gift = await issueCareVoucher(svc, salonId, client, birthdayReward, {
            voucherKind: "birthday",
            code: `BDAY-${clientCodeToken(client)}-${new Date().getUTCFullYear()}`,
            giftPhraseVi: "Quà sinh nhật",
            giftPhraseEn: "Your birthday gift",
          });
          const msg = gift ? `${baseMsg}\n\n${gift.rewardLine}` : baseMsg;
          const { ok, channel, reason } = await sendMessage(client, msg, bookingUrl, customerChannelMode, clientSmsEnabled, emailOutboundEnabled, salonReplyEmail, smsA2pRegistered);
          if (!ok && reason.startsWith("no_channel")) {
            console.warn(`[runVipCare] no channel for ${client.name} — ${reason}`);
            await svc.from("ai_actions_log" as never).insert({
              salon_id: salonId,
              agent: "vip_care",
              action_type: "skipped_no_channel",
              target_id: client.id,
              payload: { name: client.name, event: "birthday", reason },
              undo_deadline: null,
            } as never);
          }
          if (ok) {
            sentCount++;
            await svc.from("ai_actions_log" as never).insert({
              salon_id: salonId,
              agent: "vip_care",
              action_type: "birthday",
              target_id: client.id,
              payload: { name: client.name, channel, reason, preview: msg.slice(0, 120) },
              undo_deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            } as never);
          }
        }
      }

      // ── Milestones ───────────────────────────────────────────
      for (const milestone of MILESTONES) {
        const key = `milestone_${milestone}:${client.id}`;
        if (existing.has(key)) continue;
        if (client.visitCount < milestone || client.visitCount > milestone + 1) continue;
        // Fire when visits == milestone (allow +1 buffer so cron doesn't miss by 1)
        const baseMsg = await draftMessage("milestone", client, salonName, milestone);
        // Attach the admin-configured milestone gift (a real voucher code), if any.
        const gift = await issueCareVoucher(svc, salonId, client, milestoneReward, {
          voucherKind: "milestone",
          code: `MILE-${clientCodeToken(client)}-${milestone}`,
          giftPhraseVi: `Quà mốc lần thứ ${milestone}`,
          giftPhraseEn: `Your visit #${milestone} gift`,
        });
        const msg = gift ? `${baseMsg}\n\n${gift.rewardLine}` : baseMsg;
        const { ok, channel, reason } = await sendMessage(client, msg, bookingUrl, customerChannelMode, clientSmsEnabled, emailOutboundEnabled, salonReplyEmail, smsA2pRegistered);
        if (!ok && reason.startsWith("no_channel")) {
          console.warn(`[runVipCare] no channel for ${client.name} (milestone ${milestone}) — ${reason}`);
          await svc.from("ai_actions_log" as never).insert({
            salon_id: salonId,
            agent: "vip_care",
            action_type: "skipped_no_channel",
            target_id: client.id,
            payload: { name: client.name, event: `milestone_${milestone}`, reason },
            undo_deadline: null,
          } as never);
        }
        if (ok) {
          sentCount++;
          await svc.from("ai_actions_log" as never).insert({
            salon_id: salonId,
            agent: "vip_care",
            action_type: `milestone_${milestone}`,
            target_id: client.id,
            payload: { name: client.name, channel, reason, visit_count: milestone, preview: msg.slice(0, 120) },
            undo_deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          } as never);
        }
        break; // only fire one milestone per client per cron run
      }

      // ── VIP inactive 30d ─────────────────────────────────────
      if (!existing.has(`vip_inactive:${client.id}`) && client.lastVisitAt) {
        const daysSince = Math.floor((Date.now() - Date.parse(client.lastVisitAt)) / 864e5);
        if (daysSince >= 30 && daysSince < 60) {
          const msg = await draftMessage("vip_inactive", client, salonName);
          const { ok, channel, reason } = await sendMessage(client, msg, bookingUrl, customerChannelMode, clientSmsEnabled, emailOutboundEnabled, salonReplyEmail, smsA2pRegistered);
          if (!ok && reason.startsWith("no_channel")) {
            console.warn(`[runVipCare] no channel for ${client.name} — ${reason}`);
            await svc.from("ai_actions_log" as never).insert({
              salon_id: salonId,
              agent: "vip_care",
              action_type: "skipped_no_channel",
              target_id: client.id,
              payload: { name: client.name, event: "vip_inactive", reason, days_since: daysSince },
              undo_deadline: null,
            } as never);
          }
          if (ok) {
            sentCount++;
            await svc.from("ai_actions_log" as never).insert({
              salon_id: salonId,
              agent: "vip_care",
              action_type: "vip_inactive",
              target_id: client.id,
              payload: { name: client.name, channel, reason, days_since: daysSince, preview: msg.slice(0, 120) },
              undo_deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            } as never);
          }
        }
      }
    }

    if (sentCount > 0) {
      void sendOwnerAlert(salonId, {
        subject: `${salonName} — AI VIP Care: ${sentCount} message${sentCount > 1 ? "s" : ""} sent`,
        bodyText:
          `AI VIP Care đã gửi ${sentCount} tin nhắn cá nhân tới khách VIP (sinh nhật, milestone, nhắc nhở). ` +
          `Undo được trong 60 phút từ Activity feed.`,
      });
    }
  } catch (e) {
    console.error("[runVipCare]", e);
  }
}
