import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { salonToday, salonDayRangeUtc } from "@/shared/lib/salonTime";
import { sendOwnerAlert } from "@/shared/ai/sendOwnerAlert";
import type { SalonIntelligenceProfile } from "@/shared/ai/types";

/**
 * AI Social Content — Người Viết Bài Phase 1.
 *
 * Runs Mon / Wed / Fri at salon hour 8. Reads this week's real data
 * (popular services, booking trend, season), then uses Haiku to draft
 * an Instagram/Facebook caption + hashtags + image suggestion. Sends
 * the draft to the owner via email so they can copy-paste and post.
 *
 * Phase 2 (P7): add Meta Graph API auto-post when owner connects
 * their Instagram Business account.
 *
 * Gate: feature_flags.ai_social_content = true (defaults to false until
 * owner opts in via Manager Briefing or Settings).
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

const BRAND_VOICE_DESC: Record<string, string> = {
  warm_casual: "warm, conversational, like a trusted friend",
  warm_professional: "warm yet polished, friendly but credible",
  luxury_formal: "sophisticated, premium, elevated — minimal exclamation points",
  friendly_fun: "upbeat, fun, emoji-friendly, energetic",
};

const VERTICAL_CONTEXT: Record<string, string> = {
  nail: "nail salon (manicure, pedicure, nail art, gel, acrylic)",
  head_spa: "head spa (scalp treatment, relaxation, hair care)",
  massage: "massage therapy (relaxation, deep tissue, wellness)",
  facial: "facial studio (skincare, glow, anti-aging, hydration)",
  waxing: "waxing studio (smooth skin, precision, confidence)",
  multi: "beauty salon (multiple services: nails, hair, skincare)",
};

function getSeasonContext(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  const md = m * 100 + d;

  if (md >= 1220 || md <= 106) return "Holiday season / New Year";
  if (md >= 107 && md <= 214) return "New Year fresh start / Valentine's Day coming up";
  if (md >= 215 && md <= 319) return "Late winter / spring approaching";
  if (md >= 320 && md <= 430) return "Spring — renewal, fresh looks";
  if (md >= 501 && md <= 514) return "Mother's Day season";
  if (md >= 515 && md <= 620) return "Late spring / pre-summer glow-up";
  if (md >= 621 && md <= 831) return "Summer vibes — beach-ready, bold looks";
  if (md >= 901 && md <= 922) return "Back to school / fall refresh";
  if (md >= 923 && md <= 1031) return "Autumn / Halloween season";
  if (md >= 1101 && md <= 1126) return "Thanksgiving season / year-end prep";
  return "Holiday prep / festive season";
}

function dayOfWeekName(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return names[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

type WeekStats = {
  topServices: string[];
  thisWeekCount: number;
  lastWeekCount: number;
};

async function gatherWeekStats(salonId: string, tz: string): Promise<WeekStats> {
  const db = looseServiceClient();
  const todayYmd = salonToday(tz);
  const [y, mo, dy] = todayYmd.split("-").map(Number);
  const nowDay = new Date(Date.UTC(y, mo - 1, dy)).getUTCDay(); // 0=Sun
  const daysSinceMonday = nowDay === 0 ? 6 : nowDay - 1;

  // This week Mon → today
  const weekStart = new Date(Date.UTC(y, mo - 1, dy - daysSinceMonday)).toISOString().slice(0, 10);
  const { startUtc: wkStart } = salonDayRangeUtc(weekStart, tz);
  const { endUtc: wkEnd } = salonDayRangeUtc(todayYmd, tz);

  // Last week Mon → Sun
  const lastWeekEnd = new Date(Date.UTC(y, mo - 1, dy - daysSinceMonday)).toISOString().slice(0, 10);
  const lastWeekStart = new Date(Date.UTC(y, mo - 1, dy - daysSinceMonday - 7))
    .toISOString()
    .slice(0, 10);
  const { startUtc: lwStart } = salonDayRangeUtc(lastWeekStart, tz);
  const { endUtc: lwEnd } = salonDayRangeUtc(lastWeekEnd, tz);

  const [thisWeekRes, lastWeekRes, servicesRes] = await Promise.all([
    db
      .from("bookings" as never)
      .select("id" as never)
      .eq("salon_id" as never, salonId)
      .in("status" as never, ["confirmed", "completed", "in_progress"])
      .gte("start_time_utc" as never, wkStart)
      .lt("start_time_utc" as never, wkEnd),
    db
      .from("bookings" as never)
      .select("id" as never)
      .eq("salon_id" as never, salonId)
      .in("status" as never, ["confirmed", "completed", "in_progress"])
      .gte("start_time_utc" as never, lwStart)
      .lt("start_time_utc" as never, lwEnd),
    db
      .from("bookings" as never)
      .select("service:service_id(name)" as never)
      .eq("salon_id" as never, salonId)
      .in("status" as never, ["confirmed", "completed", "in_progress"])
      .gte("start_time_utc" as never, wkStart)
      .lt("start_time_utc" as never, wkEnd),
  ]);

  // Tally service popularity
  const svcCount = new Map<string, number>();
  for (const b of ((servicesRes.data ?? []) as Row[])) {
    const name = str((b.service as Record<string, unknown> | null)?.name);
    if (name) svcCount.set(name, (svcCount.get(name) ?? 0) + 1);
  }
  const topServices = Array.from(svcCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);

  return {
    topServices,
    thisWeekCount: ((thisWeekRes.data ?? []) as Row[]).length,
    lastWeekCount: ((lastWeekRes.data ?? []) as Row[]).length,
  };
}

async function alreadySentThisWeek(salonId: string, tz: string): Promise<boolean> {
  const db = createServiceRoleClient();
  const todayYmd = salonToday(tz);
  const [y, mo, dy] = todayYmd.split("-").map(Number);
  const nowDay = new Date(Date.UTC(y, mo - 1, dy)).getUTCDay();
  const daysSinceMonday = nowDay === 0 ? 6 : nowDay - 1;
  const weekStart = new Date(Date.UTC(y, mo - 1, dy - daysSinceMonday)).toISOString();

  const { data } = await db
    .from("ai_actions_log" as never)
    .select("id" as never, { count: "exact", head: true })
    .eq("salon_id" as never, salonId)
    .eq("agent" as never, "social_content")
    .gte("created_at" as never, weekStart);

  return num((data as { count?: number } | null)?.count) >= 3;
}

type SocialDraft = {
  caption: string;
  hashtags: string;
  imageSuggestion: string;
};

async function draftCaption(
  salonName: string,
  vertical: string,
  sip: Partial<SalonIntelligenceProfile> | null,
  stats: WeekStats,
  season: string,
  dayName: string,
): Promise<SocialDraft | null> {
  const ai = getAI();
  if (!ai) {
    return {
      caption: `✨ Looking for a fresh new look? Come see us at ${salonName}! Book your appointment today — link in bio.`,
      hashtags: "#nailsalon #treatyourself #bookingsopen",
      imageSuggestion: "A close-up photo of your most popular service from this week.",
    };
  }

  const lang = sip?.language_primary === "vi" ? "Vietnamese" : "English";
  const voiceDesc = BRAND_VOICE_DESC[sip?.brand_voice ?? "warm_casual"] ?? "warm and friendly";
  const vertDesc = VERTICAL_CONTEXT[vertical] ?? VERTICAL_CONTEXT.nail;
  const trendLine =
    stats.lastWeekCount > 0
      ? stats.thisWeekCount >= stats.lastWeekCount
        ? `Bookings are up this week (${stats.thisWeekCount} so far vs ${stats.lastWeekCount} last week).`
        : `${stats.lastWeekCount - stats.thisWeekCount} more bookings to go to match last week — great opportunity to fill slots.`
      : stats.thisWeekCount > 0
        ? `${stats.thisWeekCount} bookings so far this week.`
        : "";

  const topSvcLine =
    stats.topServices.length > 0
      ? `Most popular services this week: ${stats.topServices.join(", ")}.`
      : "";

  const toneNote =
    sip?.tone_examples?.length
      ? `Match this tone: "${sip.tone_examples.slice(0, 2).join('" / "')}"`
      : "";

  const prompt = `You are a social media manager for ${salonName}, a ${vertDesc}.

Today is ${dayName}. Season/occasion context: ${season}.
${trendLine}
${topSvcLine}
Brand voice: ${voiceDesc}. Write in ${lang}.
${toneNote}

Write a concise Instagram/Facebook post for ${dayName} morning. The post should:
- Feel genuine and timely (reference the season/occasion naturally, not forced)
- Highlight the salon's services or atmosphere
- Include a clear CTA (book now, DM us, link in bio)
- Be 2-4 sentences max

Then provide:
- 4-6 relevant hashtags (no more)
- A brief image/photo suggestion (1 sentence) — describe what type of real photo to pair with this post

Format your response EXACTLY like this (no extra text outside):
CAPTION: [the post text here]
HASHTAGS: [hashtags here]
IMAGE: [image suggestion here]`;

  try {
    const resp = await ai.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    if (!raw) return null;

    const captionMatch = raw.match(/CAPTION:\s*([\s\S]+?)(?=\nHASHTAGS:|$)/);
    const hashMatch = raw.match(/HASHTAGS:\s*([\s\S]+?)(?=\nIMAGE:|$)/);
    const imageMatch = raw.match(/IMAGE:\s*([\s\S]+?)$/);

    const caption = captionMatch?.[1]?.trim() ?? "";
    const hashtags = hashMatch?.[1]?.trim() ?? "";
    const imageSuggestion = imageMatch?.[1]?.trim() ?? "";

    if (!caption) return null;
    return { caption, hashtags, imageSuggestion };
  } catch {
    return null;
  }
}

export async function runSocialContent(salonId: string): Promise<void> {
  try {
    const db = looseServiceClient();
    const { data: salon } = await db
      .from("salons" as never)
      .select("name, slug, feature_flags, timezone, vertical, ai_profile" as never)
      .eq("id" as never, salonId)
      .maybeSingle();

    const s = (salon as Row | null) ?? {};
    const flags = (s.feature_flags as Record<string, unknown> | null) ?? {};
    if (flags.ai_social_content !== true) return;

    const tz = str(s.timezone) || "America/Los_Angeles";
    const salonName = str(s.name) || "our salon";
    const vertical = str(s.vertical) || "nail";
    const sip = (s.ai_profile as Partial<SalonIntelligenceProfile> | null) ?? null;

    const todayYmd = salonToday(tz);
    const [y, mo, dy] = todayYmd.split("-").map(Number);
    const dayOfWeek = new Date(Date.UTC(y, mo - 1, dy)).getUTCDay(); // 0=Sun, 1=Mon
    const isSendDay = dayOfWeek === 1 || dayOfWeek === 3 || dayOfWeek === 5; // Mon/Wed/Fri
    if (!isSendDay) return;

    // At most 3 posts per week — skip if already sent enough this week
    if (await alreadySentThisWeek(salonId, tz)) return;

    const [stats] = await Promise.all([gatherWeekStats(salonId, tz)]);

    const season = getSeasonContext(todayYmd);
    const dayName = dayOfWeekName(todayYmd);

    const draft = await draftCaption(salonName, vertical, sip, stats, season, dayName);
    if (!draft) return;

    const bookingUrl = `${(process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca"}/${str(s.slug)}`;

    const esc = (x: string) =>
      x.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));

    await sendOwnerAlert(salonId, {
      subject: `${salonName} — Caption ${dayName} từ AI`,
      bodyText:
        `Caption ${dayName} — copy để đăng Instagram/Facebook:\n\n` +
        `${draft.caption}\n\n` +
        `${draft.hashtags}\n\n` +
        `📸 Hình gợi ý: ${draft.imageSuggestion}\n\n` +
        `Đặt lịch: ${bookingUrl}`,
      bodyHtml: `
<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;color:#1a1a1a">
  <p style="font-size:12px;color:#888;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em">AI Social Draft · ${dayName}</p>

  <div style="background:#f9f9f9;border:1px solid #e5e5e5;border-radius:12px;padding:16px;margin-bottom:16px">
    <p style="font-size:13px;font-weight:600;color:#555;margin:0 0 8px">Caption</p>
    <p style="font-size:15px;line-height:1.65;margin:0;white-space:pre-wrap">${esc(draft.caption)}</p>
  </div>

  <div style="background:#f9f9f9;border:1px solid #e5e5e5;border-radius:12px;padding:14px;margin-bottom:16px">
    <p style="font-size:13px;font-weight:600;color:#555;margin:0 0 6px">Hashtags</p>
    <p style="font-size:14px;color:#1a6fd4;margin:0">${esc(draft.hashtags)}</p>
  </div>

  <div style="background:#fffbea;border:1px solid #f0d060;border-radius:12px;padding:14px;margin-bottom:20px">
    <p style="font-size:13px;font-weight:600;color:#7a6000;margin:0 0 6px">📸 Hình gợi ý</p>
    <p style="font-size:14px;color:#5a4500;margin:0">${esc(draft.imageSuggestion)}</p>
  </div>

  <a href="${bookingUrl}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:13px;font-weight:600">Xem trang đặt lịch →</a>

  <p style="font-size:11px;color:#aaa;margin-top:20px">AI Social Content — NailIQ Manager</p>
</div>`,
    });

    const svc = createServiceRoleClient();
    await svc.from("ai_actions_log" as never).insert({
      salon_id: salonId,
      agent: "social_content",
      action_type: "sent_social_draft",
      payload: {
        day: dayName,
        caption_preview: draft.caption.slice(0, 120),
        hashtags: draft.hashtags,
        top_services: stats.topServices,
      },
      // Social drafts are informational — no undo window
      undo_deadline: null,
    } as never);

    console.log(`[socialContent] ${salonName}: draft sent for ${dayName}`);
  } catch (e) {
    console.error("[runSocialContent]", e);
  }
}
