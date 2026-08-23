import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { createTextBackgroundAnthropicClient } from "@/shared/ai/anthropicProviderPolicy";
import {
  isProviderTimeoutError,
  trackAnthropicMessage,
} from "@/shared/ai/usageLedger";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  applyLearnedAgentCap,
  getLessons,
} from "@/shared/ai/lessons";
import { resolveCustomerChannel, type CustomerChannelMode } from "@/shared/lib/channelResolver";
import { isAiAgentPermissionEnabled } from "@/shared/ai/agentPermissionFence";
import {
  applyVipEmailSuppression,
  buildVipActionDedupeKeys,
} from "@/shared/ai/vipCareDelivery";
import {
  fetchAllVipRows,
  fetchVipRowsForIds,
} from "@/shared/ai/vipCareData";
import { createApprovalRequest } from "@/shared/ai/approvalRequests";
import { parseVipSpendTiers } from "@/shared/dashboard/vipSpendTier";
import {
  isEmailSuppressed,
} from "@/shared/lib/emailCompliance";

/**
 * AI VIP Care — proactive outreach to high-value customers.
 *
 * Three triggers (checked daily at salon hour 8):
 *   birthday     — 7 days before date_of_birth; once per calendar year
 *   milestone    — at 10 / 25 / 50 completed visits; once per milestone
 *   vip_inactive — VIP client silent 30+ days; once per 30-day window
 *
 * Customer communication is draft-only. Every proposal requires an explicit
 * owner/admin approval and no provider delivery is called from this agent.
 * Gate: feature_flags.ai_vip_care = true
 */

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => (v == null ? 0 : Number(v));

let anthropic: Anthropic | null = null;
function getAI(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!anthropic) anthropic = createTextBackgroundAnthropicClient(key);
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

async function loadVipClients(
  salonId: string,
  eligibility: { spendThresholdCents: number; visitThreshold: number },
): Promise<VipClient[]> {
  const db = looseServiceClient();

  // Load every tenant-scoped relationship first. These tables can exceed the
  // Supabase per-response row cap, so unpaged reads would silently omit real
  // customers and make visit/milestone decisions from incomplete data.
  const [spendRows, salonBookings, salonSquareVisits] = await Promise.all([
    fetchAllVipRows("spend", (from, to) =>
      db
        .from("salon_client_spend")
        .select("client_profile_id, total_spend_cents, payment_count")
        .eq("salon_id", salonId)
        .order("client_profile_id")
        .range(from, to)),
    fetchAllVipRows("bookings", (from, to) =>
      db
        .from("bookings")
        .select("client_profile_id, status, start_time_utc")
        .eq("salon_id", salonId)
        .order("id")
        .range(from, to)),
    fetchAllVipRows("square_visits", (from, to) =>
      db
        .from("square_visit_history")
        .select("client_profile_id, visit_date")
        .eq("salon_id", salonId)
        .order("id")
        .range(from, to)),
  ]);

  const spendSet = new Map<string, Row>();
  for (const row of spendRows) {
    const profileId = str(row.client_profile_id);
    if (profileId) spendSet.set(profileId, row);
  }

  const manualVips = await fetchAllVipRows("manual_vips", (from, to) =>
    db
      .from("salon_clients")
      .select("client_profile_id")
      .eq("salon_id", salonId)
      .eq("is_vip", true)
      .order("client_profile_id")
      .range(from, to),
  );
  const manualVipIds = new Set(
    manualVips.map((row) => str(row.client_profile_id)).filter(Boolean),
  );
  for (const profileId of manualVipIds) {
    if (!spendSet.has(profileId)) spendSet.set(profileId, {});
  }

  if (spendSet.size === 0) return [];

  const ids = Array.from(spendSet.keys());

  // Load profile details
  const profiles = await fetchVipRowsForIds(
    "profiles",
    ids,
    (profileIds, from, to) =>
      db
        .from("client_profiles")
        .select("id, phone, name, email, date_of_birth, marketing_consent_at, marketing_email_consent_at")
        .in("id", profileIds)
        .order("id")
        .range(from, to),
  );

  if (profiles.length === 0) return [];

  // Count completed bookings per client at this salon. Track each visit day
  // too, so Square-imported visits below can be merged without double-counting
  // a NailIQ booking that was also paid through Square (same-day overlap).
  const visitCountMap = new Map<string, number>();
  const bookingDayMap = new Map<string, Set<string>>();
  const lastVisitMap = new Map<string, string>();
  for (const b of salonBookings) {
    const cid = str(b.client_profile_id);
    if (!spendSet.has(cid) || b.status !== "completed") continue;
    visitCountMap.set(cid, (visitCountMap.get(cid) ?? 0) + 1);
    const completedAt = str(b.start_time_utc);
    const day = completedAt.slice(0, 10);
    if (day) {
      if (!bookingDayMap.has(cid)) bookingDayMap.set(cid, new Set());
      bookingDayMap.get(cid)!.add(day);
    }
    const previous = lastVisitMap.get(cid);
    if (completedAt && (!previous || completedAt > previous)) {
      lastVisitMap.set(cid, completedAt);
    }
  }

  // Merge Square-imported paid visits. For salons migrated from Square the
  // historical (and ongoing POS) visit ledger lives in square_visit_history,
  // NOT in bookings — so imported clients otherwise look like 0-visit / never-
  // seen and the milestone / win-back triggers never fire. Count only Square
  // visit-days with no matching completed booking that day (avoids double count
  // for the overlap set). Salons without any Square rows are unaffected.
  const squareDayMap = new Map<string, Set<string>>();
  const squareLastMap = new Map<string, string>();
  for (const v of salonSquareVisits) {
    const cid = str(v.client_profile_id);
    if (!spendSet.has(cid)) continue;
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

  // Fold in Square last-visit dates — imported clients have no booking rows,
  // and even booked clients may have a more recent Square-only payment.
  for (const [cid, day] of squareLastMap) {
    const existing = lastVisitMap.get(cid);
    if (!existing || day > existing.slice(0, 10)) lastVisitMap.set(cid, day);
  }

  const out: VipClient[] = [];
  for (const p of profiles) {
    const id = str(p.id);
    const spend = spendSet.get(id);
    const visits = visitCountMap.get(id) ?? 0;
    const spendCents = num(spend?.total_spend_cents);

    const isManualVip = manualVipIds.has(id);
    if (
      !isManualVip &&
      spendCents < eligibility.spendThresholdCents &&
      visits < eligibility.visitThreshold
    ) continue;

    out.push({
      id,
      phone: str(p.phone),
      name: str(p.name) || "there",
      email: str(p.email) || null,
      dateOfBirth: p.date_of_birth ? str(p.date_of_birth) : null,
      isVip: isManualVip,
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
  const [rows, approvalRows] = await Promise.all([
    fetchAllVipRows("existing_actions", (from, to) =>
    db
      .from("ai_actions_log" as never)
      .select("action_type, target_id, created_at" as never)
      .eq("salon_id" as never, salonId)
      .eq("agent" as never, "vip_care")
      .order("id" as never)
      .range(from, to) as unknown as PromiseLike<{
        data: Row[] | null;
        error: { message: string } | null;
      }>),
    fetchAllVipRows("existing_drafts", (from, to) =>
      db
        .from("approval_requests" as never)
        .select("payload, created_at" as never)
        .eq("salon_id" as never, salonId)
        .eq("action_type" as never, "vip_care_outreach_draft")
        .order("id" as never)
        .range(from, to) as unknown as PromiseLike<{
          data: Row[] | null;
          error: { message: string } | null;
        }>),
  ]);

  const draftActions = approvalRows.flatMap((row) => {
    const payload = row.payload as Record<string, unknown> | null;
    const event = str(payload?.event);
    const targetId = str(payload?.client_profile_id);
    return event && targetId
      ? [{ action_type: event, target_id: targetId, created_at: row.created_at }]
      : [];
  });

  return buildVipActionDedupeKeys([...rows, ...draftActions] as Array<{
    action_type: unknown;
    target_id: unknown;
    created_at: unknown;
  }>);
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
  salonId: string | null = null,
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
    const model = "claude-haiku-4-5-20251001";
    const resp = await trackAnthropicMessage(
      { salonId, feature: "vip_care_draft", model },
      () => ai.messages.create({
        model,
        max_tokens: 400, // bilingual output is ~2x
        messages: [{ role: "user", content: prompt }],
      }),
    );
    const text = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    const clean = text.replace(/^["']|["']$/g, "").trim();
    return clean.length > 10 && clean.length <= 900
      ? clean
      : `Hi ${client.name}, thinking of you at ${salonName}!\n\nChào ${client.name}, tiệm luôn nhớ bạn tại ${salonName}!`;
  } catch (error) {
    if (isProviderTimeoutError(error)) throw error;
    return `Chào ${client.name}, tiệm luôn nhớ bạn tại ${salonName}!\n\nHi ${client.name}, thinking of you at ${salonName}!`;
  }
}

async function createVipCareDraft(params: {
  salonId: string;
  client: VipClient;
  event: MessageType | `milestone_${number}`;
  message: string;
  bookingUrl: string;
  channel: ReturnType<typeof resolveCustomerChannel>;
}): Promise<boolean> {
  const requestId = await createApprovalRequest({
    salonId: params.salonId,
    actionType: "vip_care_outreach_draft",
    summary: `Review VIP Care draft for ${params.client.name} (${params.event}). No message will be sent automatically.`,
    payload: {
      proposal_source: "vip_care",
      event: params.event,
      client_profile_id: params.client.id,
      recipient_phone: params.client.phone,
      recipient_email: params.client.email,
      message: params.message,
      booking_url: params.bookingUrl,
      suggested_channels: {
        sms: params.channel.sms,
        email: params.channel.email,
        reason: params.channel.reason,
      },
      delivery_mode: "draft_only_human_send_required",
    },
    urgency: "normal",
    expiresInHours: 72,
  });
  return requestId !== null;
}

export async function runVipCare(salonId: string): Promise<void> {
  try {
    const db = looseServiceClient();
    const { data: salon, error: salonError } = await db
      .from("salons" as never)
      .select("name, slug, feature_flags, sms_outbound_enabled, sms_a2p_registered, email_outbound_enabled, customer_channel, vip_spend_tiers, vip_visit_threshold" as never)
      .eq("id" as never, salonId)
      .maybeSingle();
    if (salonError) throw new Error(`[vip_care:salon] ${salonError.message}`);

    const s = (salon as Row | null) ?? {};
    const flags = (s.feature_flags as Record<string, unknown> | null) ?? {};
    if (flags.ai_vip_care !== true) return;

    const salonName = str(s.name) || "our salon";
    const salonSlug = str(s.slug) || "";
    const smsOutboundEnabled = s.sms_outbound_enabled !== false; // default true
    const emailOutboundEnabled = s.email_outbound_enabled !== false; // default true
    const smsA2pRegistered = s.sms_a2p_registered === true; // US A2P 10DLC status
    const customerChannelMode = (str(s.customer_channel) || "smart") as CustomerChannelMode;
    const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
    const bookingUrl = `${SITE_URL}/${salonSlug}?ref=vip`;
    const spendThresholdCents = parseVipSpendTiers(s.vip_spend_tiers).bronze;
    const visitThreshold = Math.max(1, Math.min(1000, num(s.vip_visit_threshold) || 5));

    const [clients, existing, segmentLessons] = await Promise.all([
      loadVipClients(salonId, { spendThresholdCents, visitThreshold }),
      loadExistingActions(salonId),
      getLessons(salonId, "segment"),
    ]);

    if (clients.length === 0) return;

    const svc = createServiceRoleClient();
    const MILESTONES = [10, 25, 50];
    // Cap proposals so the approval inbox cannot be flooded by a backlog.
    const MAX_DRAFTS_PER_RUN = 15;
    const learnedDraftCap = applyLearnedAgentCap(
      MAX_DRAFTS_PER_RUN,
      segmentLessons,
      "vip_care",
    );
    // Channel-scoped consent: Square email-subscription (marketing_email_consent_at)
    // unlocks EMAIL only, never SMS. Gated OFF by default until deliberately enabled.
    const emailConsentEnabled = process.env.SQUARE_EMAIL_CONSENT_SEND === "1";
    let draftCount = 0;

    clientLoop: for (const client of clients) {
      if (draftCount >= learnedDraftCap) break;
      if (!(await isAiAgentPermissionEnabled(salonId, "ai_vip_care"))) break;

      // Full opt-in → SMS or email. Email-only consent (Square) → EMAIL ONLY.
      const hasFullConsent = !!client.marketingConsentAt;
      const hasEmailConsent =
        hasFullConsent || (emailConsentEnabled && !!client.marketingEmailConsentAt);
      if (!hasEmailConsent) continue;
      // Only a full opt-in permits a text; email-only consent forces email.
      const clientSmsEnabled = smsOutboundEnabled && hasFullConsent;
      const baseDelivery = resolveCustomerChannel({
        mode: customerChannelMode,
        smsOutboundEnabled: clientSmsEnabled,
        emailOutboundEnabled,
        customerEmail: client.email,
        smsA2pRegistered,
        customerPhone: client.phone,
      });
      const emailSuppressed = baseDelivery.email && client.email
        ? await isEmailSuppressed(client.email).catch(() => true)
        : false;
      const delivery = applyVipEmailSuppression(baseDelivery, emailSuppressed);

      // ── Birthday (7 days out) ─────────────────────────────────
      if (client.dateOfBirth && !existing.has(`birthday:${client.id}`)) {
        const days = daysUntilBirthday(client.dateOfBirth);
        if (days === 7) {
          if (delivery.noChannel) {
            await svc.from("ai_actions_log" as never).insert({
              salon_id: salonId,
              agent: "vip_care",
              action_type: "skipped_no_channel",
              target_id: client.id,
              payload: { name: client.name, event: "birthday", reason: delivery.reason },
              undo_deadline: null,
            } as never);
            continue clientLoop;
          }
          if (!(await isAiAgentPermissionEnabled(salonId, "ai_vip_care"))) break;
          const msg = await draftMessage("birthday", client, salonName, undefined, salonId);
          if (!(await isAiAgentPermissionEnabled(salonId, "ai_vip_care"))) {
            break clientLoop;
          }
          if (await createVipCareDraft({
            salonId, client, event: "birthday", message: msg, bookingUrl, channel: delivery,
          })) draftCount += 1;
        }
      }
      if (draftCount >= learnedDraftCap) break;

      // ── Milestones ───────────────────────────────────────────
      for (const milestone of MILESTONES) {
        const key = `milestone_${milestone}:${client.id}`;
        if (existing.has(key)) continue;
        if (client.visitCount < milestone || client.visitCount > milestone + 1) continue;
        if (delivery.noChannel) {
          await svc.from("ai_actions_log" as never).insert({
            salon_id: salonId,
            agent: "vip_care",
            action_type: "skipped_no_channel",
            target_id: client.id,
            payload: { name: client.name, event: `milestone_${milestone}`, reason: delivery.reason },
            undo_deadline: null,
          } as never);
          continue clientLoop;
        }
        if (!(await isAiAgentPermissionEnabled(salonId, "ai_vip_care"))) break;
        // Fire when visits == milestone (allow +1 buffer so cron doesn't miss by 1)
        const msg = await draftMessage("milestone", client, salonName, milestone, salonId);
        if (!(await isAiAgentPermissionEnabled(salonId, "ai_vip_care"))) {
          break clientLoop;
        }
        if (await createVipCareDraft({
          salonId,
          client,
          event: `milestone_${milestone}`,
          message: msg,
          bookingUrl,
          channel: delivery,
        })) draftCount += 1;
        break; // only fire one milestone per client per cron run
      }
      if (draftCount >= learnedDraftCap) break;

      // ── VIP inactive 30d ─────────────────────────────────────
      if (!existing.has(`vip_inactive:${client.id}`) && client.lastVisitAt) {
        const daysSince = Math.floor((Date.now() - Date.parse(client.lastVisitAt)) / 864e5);
        if (daysSince >= 30 && daysSince < 60) {
          if (delivery.noChannel) {
            await svc.from("ai_actions_log" as never).insert({
              salon_id: salonId,
              agent: "vip_care",
              action_type: "skipped_no_channel",
              target_id: client.id,
              payload: { name: client.name, event: "vip_inactive", reason: delivery.reason, days_since: daysSince },
              undo_deadline: null,
            } as never);
            continue clientLoop;
          }
          if (!(await isAiAgentPermissionEnabled(salonId, "ai_vip_care"))) {
            break clientLoop;
          }
          const msg = await draftMessage("vip_inactive", client, salonName, undefined, salonId);
          if (!(await isAiAgentPermissionEnabled(salonId, "ai_vip_care"))) {
            break clientLoop;
          }
          if (await createVipCareDraft({
            salonId,
            client,
            event: "vip_inactive",
            message: msg,
            bookingUrl,
            channel: delivery,
          })) draftCount += 1;
        }
      }
    }

  } catch (e) {
    console.error("[runVipCare]", e);
    throw e;
  }
}
