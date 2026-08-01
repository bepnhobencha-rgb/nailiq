import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { salonToday } from "@/shared/lib/salonTime";
import { sendOwnerAlert } from "@/shared/ai/sendOwnerAlert";
import type { SalonIntelligenceProfile } from "@/shared/ai/types";
import { createApprovalRequest, getPendingApprovals } from "@/shared/ai/approvalRequests";
import {
  buildStrategistApprovalProposal,
  hasPendingStrategistProposalOfType,
} from "@/shared/ai/strategistProposal";
import { findProposalCooldown, getLessons } from "@/shared/ai/lessons";

/**
 * AI Chiến Lược Gia (Weekly Strategist) — Runs every Sunday at 21:00 salon time.
 *
 * Analyses 4 weeks of data (revenue trend, service popularity, slot utilisation,
 * client retention) against the salon's primary_goal from SIP, then proposes
 * 2–3 specific actions:
 *
 *   flash_deal / message_tweak → ACT+UNDO: AI drafts promotional text and sends
 *     to owner; logged with 60-min undo window.
 *
 *   structural → ESCALATE: AI drafts recommendation + links to relevant settings;
 *     owner decides, AI never auto-applies.
 *
 * Model: claude-sonnet-4-6 (trend analysis needs deeper reasoning than Haiku).
 * Gate: always runs on Sunday 21:00 — no separate feature flag (it's analytics,
 * not outbound messaging, so it's lower-risk). Weekly dedupe via ai_actions_log.
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

// ── Data collection ───────────────────────────────────────────────────────────

type WeekBucket = {
  label: string; // "Week of Jun 9"
  bookingCount: number;
  revenueCents: number;
  completedCount: number;
};

type ServiceTrend = {
  name: string;
  recentCount: number; // last 2 weeks
  priorCount: number; // prior 2 weeks
  trend: "up" | "down" | "stable";
};

type SlotHeat = {
  dayName: string;
  hour: number;
  count: number;
};

type Analysis = {
  weeks: WeekBucket[];
  servicesTrend: ServiceTrend[];
  slotHeat: SlotHeat[]; // top 20 occupied slots
  slotCold: SlotHeat[]; // lowest 10 slots during business hours
  newClients: number;
  returningClients: number;
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function hourInTz(utcIso: string, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(utcIso));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0");
}

function dowInTz(utcIso: string, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  }).formatToParts(new Date(utcIso));
  const abbr = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(abbr);
}

async function gatherAnalysis(salonId: string, tz: string): Promise<Analysis> {
  const db = looseServiceClient();
  const since28 = new Date(Date.now() - 28 * 864e5).toISOString();
  const since14 = new Date(Date.now() - 14 * 864e5).toISOString();

  const [bookingsRes, clientsRes] = await Promise.all([
    db
      .from("bookings" as never)
      .select("start_time_utc, price_cents, status, client_profile_id, service:service_id(name)" as never)
      .eq("salon_id" as never, salonId)
      .in("status" as never, ["completed", "confirmed", "in_progress", "cancelled", "no_show"])
      .gte("start_time_utc" as never, since28),
    db
      .from("bookings" as never)
      .select("client_profile_id" as never)
      .eq("salon_id" as never, salonId)
      .in("status" as never, ["completed", "confirmed", "in_progress"])
      .gte("start_time_utc" as never, since28),
  ]);

  const allBookings = (bookingsRes.data ?? []) as Row[];
  const clientBookings = (clientsRes.data ?? []) as Row[];

  // ── Week buckets (Sun–Sat, 4 weeks) ──────────────────────────────────────
  const todayYmd = salonToday(tz);
  const [ty, tm, td] = todayYmd.split("-").map(Number);
  // Align to last 4 Sun–Sat weeks ending today
  const buckets: WeekBucket[] = [];
  for (let w = 3; w >= 0; w--) {
    const wkEnd = new Date(Date.UTC(ty, tm - 1, td - w * 7));
    const wkStart = new Date(wkEnd.getTime() - 7 * 864e5);
    const label = `Week of ${wkStart.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
    const wkBookings = allBookings.filter((b) => {
      const t = Date.parse(str(b.start_time_utc));
      return t >= wkStart.getTime() && t < wkEnd.getTime();
    });
    buckets.push({
      label,
      bookingCount: wkBookings.length,
      revenueCents: wkBookings.reduce((s, b) => s + num(b.price_cents), 0),
      completedCount: wkBookings.filter((b) => str(b.status) === "completed").length,
    });
  }

  // ── Service trends ─────────────────────────────────────────────────────────
  const recentBk = allBookings.filter((b) => Date.parse(str(b.start_time_utc)) >= Date.parse(since14));
  const priorBk = allBookings.filter((b) => Date.parse(str(b.start_time_utc)) < Date.parse(since14));

  const countBySvc = (arr: Row[]) => {
    const m = new Map<string, number>();
    for (const b of arr) {
      const name = str((b.service as Record<string, unknown> | null)?.name);
      if (name) m.set(name, (m.get(name) ?? 0) + 1);
    }
    return m;
  };

  const recentSvcMap = countBySvc(recentBk);
  const priorSvcMap = countBySvc(priorBk);
  const allSvcNames = new Set([...recentSvcMap.keys(), ...priorSvcMap.keys()]);

  const servicesTrend: ServiceTrend[] = Array.from(allSvcNames)
    .map((name) => {
      const r = recentSvcMap.get(name) ?? 0;
      const p = priorSvcMap.get(name) ?? 0;
      const trend: "up" | "down" | "stable" =
        r > p + 1 ? "up" : r < p - 1 ? "down" : "stable";
      return { name, recentCount: r, priorCount: p, trend };
    })
    .sort((a, b) => b.recentCount - a.recentCount)
    .slice(0, 10);

  // ── Slot heat map ──────────────────────────────────────────────────────────
  const slotMap = new Map<string, number>();
  for (const b of allBookings) {
    if (str(b.status) === "cancelled" || str(b.status) === "no_show") continue;
    const t = str(b.start_time_utc);
    if (!t) continue;
    const dow = dowInTz(t, tz);
    const hour = hourInTz(t, tz);
    const key = `${dow}:${hour}`;
    slotMap.set(key, (slotMap.get(key) ?? 0) + 1);
  }

  const slotEntries = Array.from(slotMap.entries()).map(([k, count]) => {
    const [dow, hour] = k.split(":").map(Number);
    return { dayName: DAY_NAMES[dow], hour, count };
  });

  const slotHeat = [...slotEntries].sort((a, b) => b.count - a.count).slice(0, 15);
  // Cold slots = business hours (9–19) with low occupancy
  const coldCandidates = slotEntries.filter((s) => s.hour >= 9 && s.hour <= 19);
  const slotCold = coldCandidates.sort((a, b) => a.count - b.count).slice(0, 8);

  // ── Retention ─────────────────────────────────────────────────────────────
  const visitsByClient = new Map<string, number>();
  for (const b of clientBookings) {
    const cid = str(b.client_profile_id);
    if (cid) visitsByClient.set(cid, (visitsByClient.get(cid) ?? 0) + 1);
  }
  let newClients = 0;
  let returningClients = 0;
  for (const count of visitsByClient.values()) {
    if (count === 1) newClients++;
    else returningClients++;
  }

  return { weeks: buckets, servicesTrend, slotHeat, slotCold, newClients, returningClients };
}

// ── Sonnet analysis ───────────────────────────────────────────────────────────

type Recommendation = {
  type: "flash_deal" | "message_tweak" | "structural";
  title: string;
  reasoning: string;
  draft_message?: string;   // for flash_deal / message_tweak
  escalate_detail?: string; // for structural
  settings_path?: string;   // settings page hint for structural
};

type StrategistOutput = {
  summary: string;
  recommendations: Recommendation[];
};

function formatAnalysisForPrompt(data: Analysis): string {
  const weekLines = data.weeks
    .map((w) => `  ${w.label}: ${w.bookingCount} bookings, $${(w.revenueCents / 100).toFixed(0)} est. revenue, ${w.completedCount} completed`)
    .join("\n");

  const svcLines = data.servicesTrend
    .slice(0, 6)
    .map((s) => `  ${s.name}: ${s.recentCount} (recent 2w) vs ${s.priorCount} (prior 2w) → ${s.trend}`)
    .join("\n");

  const hotSlots = data.slotHeat
    .slice(0, 5)
    .map((s) => `  ${s.dayName} ${s.hour}:00 — ${s.count} bookings`)
    .join("\n");

  const coldSlots = data.slotCold
    .slice(0, 5)
    .map((s) => `  ${s.dayName} ${s.hour}:00 — ${s.count} bookings`)
    .join("\n");

  const total28 = data.weeks.reduce((s, w) => s + w.bookingCount, 0);
  const totalRevenue = data.weeks.reduce((s, w) => s + w.revenueCents, 0);
  const retentionRate =
    data.returningClients + data.newClients > 0
      ? Math.round((data.returningClients / (data.returningClients + data.newClients)) * 100)
      : 0;

  return `LAST 4 WEEKS SUMMARY
Total: ${total28} bookings, ~$${(totalRevenue / 100).toFixed(0)} revenue

WEEKLY TREND
${weekLines}

SERVICE POPULARITY (recent 2w vs prior 2w)
${svcLines || "  (no service data)"}

BUSIEST SLOTS
${hotSlots || "  (no data)"}

QUIETEST BUSINESS-HOUR SLOTS
${coldSlots || "  (no data)"}

CLIENT RETENTION (last 28 days)
  New clients: ${data.newClients}
  Returning clients: ${data.returningClients}
  Retention rate: ${retentionRate}%`;
}

async function runAnalysis(
  salonName: string,
  vertical: string,
  sip: Partial<SalonIntelligenceProfile> | null,
  data: Analysis,
  settingsUrl: string,
): Promise<StrategistOutput | null> {
  const ai = getAI();
  if (!ai) return null;

  const goalDesc: Record<string, string> = {
    retain_regulars: "keep existing loyal customers coming back (retention first)",
    attract_new: "bring in new clients and grow the customer base",
    maximize_revenue: "increase revenue per visit and fill idle capacity",
  };
  const goal = sip?.primary_goal ? goalDesc[sip.primary_goal] ?? sip.primary_goal : "grow the salon";
  const lang = sip?.language_primary === "vi" ? "Vietnamese" : "English";

  const prompt = `You are a senior salon business strategist reviewing the last 4 weeks of data for "${salonName}" (${vertical} salon). The owner's primary goal: ${goal}.

${formatAnalysisForPrompt(data)}

Based on this data, propose exactly 2–3 specific, actionable recommendations. Each must cite specific data from the numbers above.

For each recommendation, choose one type:
- "flash_deal": a limited-time promotional message to fill quiet slots (e.g. "Tuesday afternoons only: 15% off gel nails this week"). Include the actual promotional text ready to post/send.
- "message_tweak": a customer communication to improve retention or re-engage (e.g. reframe the booking confirmation to mention a specific popular service). Include draft text.
- "structural": a lasting change (e.g. adjust pricing, retire a low-demand service, add a new service). Do NOT try to make this change yourself — just recommend it clearly.

Write all recommendation text in ${lang}.

Respond with ONLY valid JSON, no markdown fences, in exactly this format:
{
  "summary": "1-2 sentence plain-language insight about the salon's biggest opportunity this week",
  "recommendations": [
    {
      "type": "flash_deal",
      "title": "Short title (max 8 words)",
      "reasoning": "1-2 sentences citing specific data",
      "draft_message": "The ready-to-post promotional text (for flash_deal/message_tweak). Omit for structural."
    }
  ]
}`;

  try {
    const resp = await ai.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    if (!raw) return null;

    // Strip markdown fences if model added them despite instructions
    const cleaned = raw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as StrategistOutput;
    if (!parsed.summary || !Array.isArray(parsed.recommendations)) return null;

    // Inject settings URL for structural recommendations
    for (const rec of parsed.recommendations) {
      if (rec.type === "structural") {
        rec.settings_path = settingsUrl;
      }
    }

    return parsed;
  } catch (e) {
    console.error("[strategist] Sonnet parse error", e);
    return null;
  }
}

// ── Dedup ─────────────────────────────────────────────────────────────────────

async function alreadyRanThisWeek(salonId: string): Promise<boolean> {
  const db = createServiceRoleClient();
  const since = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await db
    .from("ai_actions_log" as never)
    .select("id" as never)
    .eq("salon_id" as never, salonId)
    .eq("agent" as never, "strategist")
    .gte("created_at" as never, since)
    .limit(1);
  return ((data ?? []) as unknown as Row[]).length > 0;
}

// ── Email formatter ───────────────────────────────────────────────────────────

function buildEmail(
  salonName: string,
  output: StrategistOutput,
  settingsUrl: string,
): { subject: string; bodyText: string; bodyHtml: string } {
  const esc = (x: string) =>
    x.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));

  const typeLabel: Record<string, string> = {
    flash_deal: "⚡ Flash Deal",
    message_tweak: "💬 Message Tweak",
    structural: "🏗 Cải thiện cơ cấu",
  };

  const typeBorder: Record<string, string> = {
    flash_deal: "#22c55e",
    message_tweak: "#3b82f6",
    structural: "#f59e0b",
  };

  const recHtml = output.recommendations
    .map((r) => {
      const border = typeBorder[r.type] ?? "#888";
      const label = typeLabel[r.type] ?? r.type;
      const draftSection = r.draft_message
        ? `<div style="background:#f0f9ff;border-radius:8px;padding:12px;margin-top:10px"><p style="font-size:12px;font-weight:600;color:#1e40af;margin:0 0 6px">Draft (copy &amp; post):</p><p style="font-size:14px;margin:0;white-space:pre-wrap">${esc(r.draft_message)}</p></div>`
        : "";
      const structSection = r.type === "structural"
        ? `<a href="${settingsUrl}" style="display:inline-block;margin-top:10px;background:#1a1a1a;color:#fff;text-decoration:none;padding:8px 16px;border-radius:6px;font-size:12px">Vào Settings →</a>`
        : "";
      return `
<div style="border-left:4px solid ${border};padding:12px 16px;margin-bottom:14px;background:#fafafa;border-radius:0 8px 8px 0">
  <p style="font-size:11px;font-weight:700;color:${border};margin:0 0 4px;text-transform:uppercase;letter-spacing:0.05em">${label}</p>
  <p style="font-size:15px;font-weight:600;margin:0 0 6px">${esc(r.title)}</p>
  <p style="font-size:13px;color:#555;margin:0">${esc(r.reasoning)}</p>
  ${draftSection}${structSection}
</div>`;
    })
    .join("");

  const bodyHtml = `
<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;color:#1a1a1a">
  <p style="font-size:12px;color:#888;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em">AI Chiến Lược Gia · Weekly Report</p>
  <h2 style="font-size:18px;font-weight:700;margin:0 0 8px">${esc(salonName)}</h2>
  <p style="font-size:14px;color:#444;line-height:1.6;margin:0 0 20px">${esc(output.summary)}</p>
  ${recHtml}
  <p style="font-size:11px;color:#aaa;margin-top:24px">NailIQ AI Manager · Weekly Strategist · Undo ACT+UNDO items from Activity feed within 60 min</p>
</div>`;

  const textRecs = output.recommendations
    .map((r, i) => {
      const label = typeLabel[r.type] ?? r.type;
      const draft = r.draft_message ? `\nDraft: "${r.draft_message}"` : "";
      const link = r.type === "structural" ? `\nSettings: ${settingsUrl}` : "";
      return `${i + 1}. [${label}] ${r.title}\n${r.reasoning}${draft}${link}`;
    })
    .join("\n\n");

  const bodyText = `AI Chiến Lược Gia — ${salonName}\n\n${output.summary}\n\n${textRecs}`;

  return {
    subject: `${salonName} — AI Chiến Lược Gia: ${output.recommendations.length} gợi ý tuần này`,
    bodyText,
    bodyHtml,
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runStrategist(salonId: string): Promise<void> {
  try {
    const db = looseServiceClient();
    const { data: salon } = await db
      .from("salons" as never)
      .select("name, slug, timezone, vertical, ai_profile" as never)
      .eq("id" as never, salonId)
      .maybeSingle();

    const s = (salon as Row | null) ?? {};
    const tz = str(s.timezone) || "America/Los_Angeles";
    const salonName = str(s.name) || "our salon";
    const salonSlug = str(s.slug) || "";
    const vertical = str(s.vertical) || "nail";
    const sip = (s.ai_profile as Partial<SalonIntelligenceProfile> | null) ?? null;

    if (await alreadyRanThisWeek(salonId)) return;

    const data = await gatherAnalysis(salonId, tz);

    // Need at least 2 weeks of data before giving meaningful advice
    const totalBookings = data.weeks.reduce((s, w) => s + w.bookingCount, 0);
    if (totalBookings < 10) return;

    const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
    const settingsUrl = `${SITE_URL}/dashboard/${salonSlug}/settings`;

    const output = await runAnalysis(salonName, vertical, sip, data, settingsUrl);
    if (!output) return;

    const { subject, bodyText, bodyHtml } = buildEmail(salonName, output, settingsUrl);

    await sendOwnerAlert(salonId, { subject, bodyText, bodyHtml });

    // Log each recommendation separately so ActivityFeed can show them
    const svc = createServiceRoleClient();
    const proposalCooldown = findProposalCooldown(
      await getLessons(salonId, "policy"),
      {
        actionType: "bulk_message",
        proposalSource: "weekly_strategist",
      },
    );
    const hasPendingStrategistProposal = hasPendingStrategistProposalOfType(
      await getPendingApprovals(salonId),
      { actionType: "bulk_message", proposalSource: "weekly_strategist" },
    );
    let approvalCreated = hasPendingStrategistProposal;
    let suppressionLogged = false;

    for (const rec of output.recommendations) {
      const isActable = rec.type === "flash_deal" || rec.type === "message_tweak";
      await svc.from("ai_actions_log" as never).insert({
        salon_id: salonId,
        agent: "strategist",
        action_type: rec.type === "structural" ? "escalate_structural" : `draft_${rec.type}`,
        payload: {
          title: rec.title,
          reasoning: rec.reasoning,
          draft_message: rec.draft_message ?? null,
          summary: rec.title,
          strategist_summary: output.summary,
        },
        undo_deadline: isActable ? new Date(Date.now() + 60 * 60 * 1000).toISOString() : null,
      } as never);

      if (
        rec.type !== "structural" &&
        rec.draft_message &&
        proposalCooldown &&
        !suppressionLogged
      ) {
        await svc.from("ai_actions_log" as never).insert({
          salon_id: salonId,
          agent: "strategist",
          action_type: "proposal_suppressed_owner_preference",
          payload: {
            approval_action_type: "bulk_message",
            proposal_source: "weekly_strategist",
            lesson_id: proposalCooldown.lessonId,
            suppress_until: proposalCooldown.suppressUntil,
            summary: "Owner preference cooldown prevented a repeated approval request.",
          },
        } as never);
        suppressionLogged = true;
      }

      if (
        rec.type !== "structural" &&
        rec.draft_message &&
        !approvalCreated &&
        !proposalCooldown
      ) {
        const proposal = buildStrategistApprovalProposal({
          type: rec.type,
          title: rec.title,
          reasoning: rec.reasoning,
          draftMessage: rec.draft_message,
          coldSlots: data.slotCold,
          totalBookings,
          returningClients: data.returningClients,
          newClients: data.newClients,
        });
        const requestId = await createApprovalRequest({
          salonId,
          actionType: proposal.actionType,
          summary: proposal.summary,
          payload: proposal.payload,
          urgency: "normal",
          expiresInHours: 72,
        });
        approvalCreated = requestId !== null;
      }
    }

    console.log(`[strategist] ${salonName}: ${output.recommendations.length} recommendations sent`);
  } catch (e) {
    console.error("[runStrategist]", e);
    throw e;
  }
}
