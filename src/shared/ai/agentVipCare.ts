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
    .select("id, phone, name, email, date_of_birth, is_vip" as never)
    .in("id" as never, ids);

  if (!profiles?.length) return [];

  // Count completed bookings per client at this salon
  const { data: bookingCounts } = await (db as ReturnType<typeof looseServiceClient>)
    .from("bookings" as never)
    .select("client_profile_id, id" as never)
    .eq("salon_id" as never, salonId)
    .eq("status" as never, "completed")
    .in("client_profile_id" as never, ids);

  const visitCountMap = new Map<string, number>();
  for (const b of (bookingCounts ?? []) as Row[]) {
    const cid = str(b.client_profile_id);
    visitCountMap.set(cid, (visitCountMap.get(cid) ?? 0) + 1);
  }

  // Latest booking per client
  const { data: latestRows } = await (db as ReturnType<typeof looseServiceClient>)
    .from("bookings" as never)
    .select("client_profile_id, start_time" as never)
    .eq("salon_id" as never, salonId)
    .in("client_profile_id" as never, ids)
    .order("start_time" as never, { ascending: false });

  const lastVisitMap = new Map<string, string>();
  for (const b of (latestRows ?? []) as Row[]) {
    const cid = str(b.client_profile_id);
    if (!lastVisitMap.has(cid)) lastVisitMap.set(cid, str(b.start_time));
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
    // Fallback plain text
    if (type === "birthday") return `Hi ${client.name}, your birthday is coming up — we'd love to celebrate with you at ${salonName}! Book a special visit: `;
    if (type === "milestone") return `Hi ${client.name}, you've hit visit #${visitCount} at ${salonName} — thank you so much! As a token of our appreciation: `;
    return `Hi ${client.name}, we've been thinking of you! It's been a little while — we'd love to see you again at ${salonName}: `;
  }

  let prompt: string;
  if (type === "birthday") {
    prompt = `Write a warm, brief birthday message (1-2 sentences) in English for a VIP salon customer whose birthday is coming up in about a week. Customer name: ${client.name}. Salon: ${salonName}. Be personal and caring — invite them to celebrate with a visit. No emojis, no links (added separately). Return ONLY the message text.`;
  } else if (type === "milestone") {
    prompt = `Write a short, genuine thank-you message (1-2 sentences) for a loyal VIP salon customer celebrating their ${visitCount}th visit. Customer name: ${client.name}. Salon: ${salonName}. Express authentic gratitude and make them feel valued. No emojis, no links. Return ONLY the message text.`;
  } else {
    prompt = `Write a warm, brief "we miss you" message (1-2 sentences) for a VIP salon customer who hasn't visited in about a month. Customer name: ${client.name}. Salon: ${salonName}. Make it feel caring, not pushy — gently invite them back. No emojis, no links. Return ONLY the message text.`;
  }

  try {
    const resp = await ai.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    const clean = text.replace(/^["']|["']$/g, "").trim();
    return clean.length > 10 && clean.length <= 480 ? clean : `Hi ${client.name}, thinking of you at ${salonName}!`;
  } catch {
    return `Hi ${client.name}, thinking of you at ${salonName}!`;
  }
}

async function sendMessage(
  client: VipClient,
  message: string,
  bookingUrl: string,
  channelMode: CustomerChannelMode,
  smsOutboundEnabled: boolean,
  salonReplyEmail?: string | null,
): Promise<{ ok: boolean; channel: "sms" | "email"; reason: string }> {
  const ch = resolveCustomerChannel({
    mode: channelMode,
    smsOutboundEnabled,
    customerEmail: client.email,
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

export async function runVipCare(salonId: string): Promise<void> {
  try {
    const db = looseServiceClient();
    const { data: salon } = await db
      .from("salons" as never)
      .select("name, email, slug, feature_flags, sms_outbound_enabled, customer_channel" as never)
      .eq("id" as never, salonId)
      .maybeSingle();

    const s = (salon as Row | null) ?? {};
    const flags = (s.feature_flags as Record<string, unknown> | null) ?? {};
    if (flags.ai_vip_care !== true) return;

    const salonName = str(s.name) || "our salon";
    const salonSlug = str(s.slug) || "";
    const salonReplyEmail = str(s.email) || null;
    const smsOutboundEnabled = s.sms_outbound_enabled !== false; // default true
    const customerChannelMode = (str(s.customer_channel) || "smart") as CustomerChannelMode;
    const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
    const bookingUrl = `${SITE_URL}/${salonSlug}?ref=vip`;

    const [clients, existing] = await Promise.all([
      loadVipClients(salonId),
      loadExistingActions(salonId),
    ]);

    if (clients.length === 0) return;

    const svc = createServiceRoleClient();
    const MILESTONES = [10, 25, 50];
    let sentCount = 0;

    for (const client of clients) {
      // ── Birthday (7 days out) ─────────────────────────────────
      if (client.dateOfBirth && !existing.has(`birthday:${client.id}`)) {
        const days = daysUntilBirthday(client.dateOfBirth);
        if (days === 7) {
          const msg = await draftMessage("birthday", client, salonName);
          const { ok, channel, reason } = await sendMessage(client, msg, bookingUrl, customerChannelMode, smsOutboundEnabled, salonReplyEmail);
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
        const msg = await draftMessage("milestone", client, salonName, milestone);
        const { ok, channel, reason } = await sendMessage(client, msg, bookingUrl, customerChannelMode, smsOutboundEnabled, salonReplyEmail);
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
          const { ok, channel, reason } = await sendMessage(client, msg, bookingUrl, customerChannelMode, smsOutboundEnabled, salonReplyEmail);
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
