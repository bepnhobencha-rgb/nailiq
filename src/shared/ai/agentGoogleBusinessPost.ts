import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { salonToday, salonDayRangeUtc } from "@/shared/lib/salonTime";
import { sendOwnerAlert } from "@/shared/ai/sendOwnerAlert";
import type { SalonIntelligenceProfile } from "@/shared/ai/types";

/**
 * AI Google Business Post — Minh's GBP content agent.
 *
 * Runs on the 1st and 15th of each month at salon hour 10:00.
 * Generates a ready-to-post Google Business Profile update tailored to
 * the salon's vertical, brand voice, and seasonal context. Sends the
 * draft to the owner via email with step-by-step instructions to post.
 *
 * Phase 2: Add google_business_refresh_token column + OAuth flow to auto-post
 * without the manual copy-paste step (see agentReviewResponder for the
 * "future phase expects OAuth" pattern already established).
 *
 * Gate: feature_flags.ai_gbp_post = true + salons.google_place_id non-null
 * (place_id is the GBP identifier used to generate the management deep-link).
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
  luxury_formal: "sophisticated, premium, elevated — use formal phrasing, no exclamation points",
  friendly_fun: "upbeat, fun, emoji-friendly, energetic",
};

const VERTICAL_CONTEXT: Record<string, string> = {
  nail: "nail salon specialising in manicure, pedicure, nail art, gel, and acrylic",
  head_spa: "head spa specialising in scalp treatment, deep relaxation, and scalp health",
  massage: "massage therapy studio offering relaxation, deep tissue, and wellness",
  facial: "facial studio specialising in skincare, glow treatments, and anti-aging",
  waxing: "waxing studio offering smooth-skin treatments with precision",
  multi: "full-service beauty salon offering nails, hair, and skincare",
};

const POST_THEMES = [
  "seasonal_special",
  "service_spotlight",
  "wellness_tip",
  "behind_the_scenes",
  "limited_offer",
  "community_love",
] as const;
type PostTheme = (typeof POST_THEMES)[number];

function getSeasonContext(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  const md = m * 100 + d;

  if (md >= 1220 || md <= 106) return "Holiday season / New Year";
  if (md >= 107 && md <= 214) return "New Year fresh start / Valentine's Day approaching";
  if (md >= 215 && md <= 319) return "Late winter / spring on the horizon";
  if (md >= 320 && md <= 430) return "Spring — renewal, fresh looks, outdoor energy";
  if (md >= 501 && md <= 514) return "Mother's Day season — gifting and self-care surge";
  if (md >= 515 && md <= 620) return "Late spring / pre-summer glow-up";
  if (md >= 621 && md <= 831) return "Summer — heat, outdoor activities, self-care essentials";
  if (md >= 901 && md <= 922) return "Back-to-school / fall refresh";
  if (md >= 923 && md <= 1031) return "Autumn / Halloween — bold looks, cozy vibes";
  if (md >= 1101 && md <= 1126) return "Thanksgiving — gratitude, year-end prep";
  return "Holiday prep / festive season";
}

// Pick a theme based on the posting date (1st vs 15th) and month so posts vary
function pickTheme(ymd: string, isFirstOfMonth: boolean): PostTheme {
  const [, m] = ymd.split("-").map(Number);
  // Even months get one rotation, odd months another — ensures variety
  const rotation = isFirstOfMonth
    ? POST_THEMES[(m * 2) % POST_THEMES.length]
    : POST_THEMES[(m * 2 + 1) % POST_THEMES.length];
  return rotation;
}

type GbpDraft = {
  postText: string;
  callToAction: string; // e.g. "Book Now" or "Learn More"
  imageSuggestion: string;
  theme: PostTheme;
};

type RecentStats = {
  topServices: string[];
  bookingsThisMonth: number;
};

async function gatherMonthStats(salonId: string, tz: string): Promise<RecentStats> {
  const db = looseServiceClient();
  const todayYmd = salonToday(tz);
  const [y, mo] = todayYmd.split("-").map(Number);
  const monthStart = `${y}-${String(mo).padStart(2, "0")}-01`;

  const { startUtc } = salonDayRangeUtc(monthStart, tz);
  const { endUtc } = salonDayRangeUtc(todayYmd, tz);

  const [countRes, servicesRes] = await Promise.all([
    db
      .from("bookings" as never)
      .select("id" as never)
      .eq("salon_id" as never, salonId)
      .in("status" as never, ["confirmed", "completed", "in_progress"])
      .gte("start_time_utc" as never, startUtc)
      .lt("start_time_utc" as never, endUtc),
    db
      .from("bookings" as never)
      .select("service:service_id(name)" as never)
      .eq("salon_id" as never, salonId)
      .in("status" as never, ["confirmed", "completed", "in_progress"])
      .gte("start_time_utc" as never, startUtc)
      .lt("start_time_utc" as never, endUtc),
  ]);

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
    bookingsThisMonth: ((countRes.data ?? []) as Row[]).length,
  };
}

async function alreadySentThisPeriod(salonId: string, todayYmd: string): Promise<boolean> {
  const db = createServiceRoleClient();
  const [y, mo, dy] = todayYmd.split("-").map(Number);

  // Window: 1st → look back 10 days; 15th → look back 10 days
  const windowStart = new Date(Date.UTC(y, mo - 1, dy - 10)).toISOString();

  const { data } = await db
    .from("ai_actions_log" as never)
    .select("id" as never)
    .eq("salon_id" as never, salonId)
    .eq("agent" as never, "gbp_post")
    .gte("created_at" as never, windowStart);

  return ((data ?? []) as unknown as Row[]).length > 0;
}

async function draftPost(
  salonName: string,
  vertical: string,
  sip: Partial<SalonIntelligenceProfile> | null,
  stats: RecentStats,
  season: string,
  theme: PostTheme,
  bookingUrl: string,
): Promise<GbpDraft | null> {
  const ai = getAI();

  // Fallback when no AI key
  if (!ai) {
    const text =
      `✨ ${salonName} — your local ${VERTICAL_CONTEXT[vertical] ?? "beauty"} destination. ` +
      `${season}. Book your next visit online and experience the difference. ` +
      `Limited spots available — reserve yours today!`;
    return {
      postText: text,
      callToAction: "Book Now",
      imageSuggestion: "A bright, welcoming photo of the studio interior or a treatment in progress.",
      theme,
    };
  }

  const lang = sip?.language_primary === "vi" ? "Vietnamese" : "English";
  const voiceDesc = BRAND_VOICE_DESC[sip?.brand_voice ?? "warm_professional"] ?? "warm yet polished";
  const vertDesc = VERTICAL_CONTEXT[vertical] ?? VERTICAL_CONTEXT.nail;

  const toneNote =
    sip?.tone_examples?.length
      ? `Tone reference (match this voice): "${sip.tone_examples.slice(0, 2).join('" / "')}"`
      : "";

  const topSvcLine =
    stats.topServices.length > 0
      ? `Most booked services this month: ${stats.topServices.join(", ")}.`
      : "";

  const themeGuide: Record<PostTheme, string> = {
    seasonal_special: `Tie the post to the current season/occasion (${season}). Highlight a seasonal service or limited-time experience.`,
    service_spotlight: `Feature one specific signature service from the salon. Explain what makes it special, the benefit, and who it's for.`,
    wellness_tip: `Share a genuine wellness or self-care tip relevant to ${vertDesc}. Position the salon as the expert and suggest booking.`,
    behind_the_scenes: `Give a glimpse behind the curtain — the team, the craft, the care that goes into each session. Human and warm.`,
    limited_offer: `Create urgency around a limited-time or limited-spot offer. Include a clear value proposition and CTA.`,
    community_love: `Express gratitude to the local community, mention a milestone or thank regulars. Warm and authentic.`,
  };

  const prompt = `You are writing a Google Business Profile post for ${salonName}, a ${vertDesc}.

Season / occasion: ${season}
Post theme: ${themeGuide[theme]}
${topSvcLine}
Brand voice: ${voiceDesc}
Write in: ${lang}
${toneNote}

Rules:
- 150-300 words max (Google Business posts cut off after ~1500 characters but shorter performs better)
- No hashtags (Google Business Profile does not render them)
- Must end with a clear call to action. Use this booking URL: ${bookingUrl}
- Genuine and specific — avoid generic filler like "world-class" or "best in class"
- No all-caps words or excessive punctuation

Also choose the best CTA button type for this post:
- "Book Now" — when directly inviting bookings
- "Learn More" — when sharing tips/info
- "Call Now" — when urgency or personal touch matters

Finally, suggest a photo/image to pair with this post (1 sentence — describe a real photo the owner could take or already has).

Format your response EXACTLY like this (no extra text outside the labels):
POST: [post text here]
CTA: [Book Now | Learn More | Call Now]
IMAGE: [image suggestion here]`;

  try {
    const resp = await ai.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    if (!raw) return null;

    const postMatch = raw.match(/POST:\s*([\s\S]+?)(?=\nCTA:|$)/);
    const ctaMatch = raw.match(/CTA:\s*([\s\S]+?)(?=\nIMAGE:|$)/);
    const imageMatch = raw.match(/IMAGE:\s*([\s\S]+?)$/);

    const postText = postMatch?.[1]?.trim() ?? "";
    const ctaRaw = ctaMatch?.[1]?.trim() ?? "Book Now";
    const imageSuggestion = imageMatch?.[1]?.trim() ?? "";

    if (!postText) return null;

    const validCtas = ["Book Now", "Learn More", "Call Now"] as const;
    const callToAction = (validCtas.find((c) => ctaRaw.includes(c)) ?? "Book Now") as string;

    return { postText, callToAction, imageSuggestion, theme };
  } catch {
    return null;
  }
}

export async function runGbpPost(salonId: string): Promise<void> {
  try {
    const db = looseServiceClient();
    const { data: salon } = await db
      .from("salons" as never)
      .select("name, slug, feature_flags, timezone, vertical, ai_profile, google_place_id" as never)
      .eq("id" as never, salonId)
      .maybeSingle();

    const s = (salon as Row | null) ?? {};
    const flags = (s.feature_flags as Record<string, unknown> | null) ?? {};
    if (flags.ai_gbp_post !== true) return;

    const placeId = str(s.google_place_id);
    if (!placeId) return; // need place_id to build the GBP management link

    const tz = str(s.timezone) || "America/Los_Angeles";
    const todayYmd = salonToday(tz);
    const day = parseInt(todayYmd.split("-")[2], 10);

    // Only fire on the 1st and 15th of each month
    if (day !== 1 && day !== 15) return;

    if (await alreadySentThisPeriod(salonId, todayYmd)) return;

    const salonName = str(s.name) || "our salon";
    const vertical = str(s.vertical) || "nail";
    const sip = (s.ai_profile as Partial<SalonIntelligenceProfile> | null) ?? null;
    const slug = str(s.slug);

    const [stats] = await Promise.all([gatherMonthStats(salonId, tz)]);

    const season = getSeasonContext(todayYmd);
    const isFirstOfMonth = day === 1;
    const theme = pickTheme(todayYmd, isFirstOfMonth);

    const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
    const bookingUrl = slug ? `${appUrl}/${slug}` : appUrl;

    const draft = await draftPost(salonName, vertical, sip, stats, season, theme, bookingUrl);
    if (!draft) return;

    // GBP management link — takes owner straight to the Posts tab
    const gbpSearchUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(salonName)}&query_place_id=${encodeURIComponent(placeId)}`;
    const gbpManageUrl = `https://business.google.com/`;

    const periodLabel = isFirstOfMonth ? "đầu tháng" : "giữa tháng";
    const themeLabel: Record<PostTheme, string> = {
      seasonal_special: "Chủ đề mùa / dịp lễ",
      service_spotlight: "Spotlight dịch vụ",
      wellness_tip: "Tip chăm sóc bản thân",
      behind_the_scenes: "Hậu trường salon",
      limited_offer: "Ưu đãi giới hạn",
      community_love: "Cảm ơn cộng đồng",
    };

    const esc = (x: string) =>
      x.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));

    await sendOwnerAlert(salonId, {
      subject: `${salonName} — Bài đăng Google Business ${periodLabel} từ Minh`,
      bodyText:
        `Bài đăng Google Business ${periodLabel} (${themeLabel[theme]}):\n\n` +
        `${draft.postText}\n\n` +
        `📸 Hình gợi ý: ${draft.imageSuggestion}\n` +
        `🔘 Nút CTA: ${draft.callToAction}\n\n` +
        `--- Cách đăng ---\n` +
        `1. Mở Google Business Profile: ${gbpManageUrl}\n` +
        `2. Chọn đúng trang salon → Nhấn "Add update" (hoặc "Tạo bài đăng")\n` +
        `3. Dán nội dung trên → Thêm ảnh → Chọn nút CTA "${draft.callToAction}"\n` +
        `4. URL cho nút CTA: ${bookingUrl}\n\n` +
        `Trang Google Maps: ${gbpSearchUrl}`,
      bodyHtml: `
<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:580px;color:#1a1a1a">
  <p style="font-size:12px;color:#888;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em">
    Minh · Google Business Post · ${periodLabel} · ${themeLabel[theme]}
  </p>

  <div style="background:#f9f9f9;border:1px solid #e5e5e5;border-radius:12px;padding:18px;margin-bottom:16px">
    <p style="font-size:13px;font-weight:600;color:#555;margin:0 0 10px">Nội dung bài đăng</p>
    <p style="font-size:15px;line-height:1.7;margin:0;white-space:pre-wrap">${esc(draft.postText)}</p>
  </div>

  <div style="display:flex;gap:12px;margin-bottom:16px">
    <div style="flex:1;background:#f9f9f9;border:1px solid #e5e5e5;border-radius:12px;padding:14px">
      <p style="font-size:13px;font-weight:600;color:#555;margin:0 0 6px">🔘 Nút CTA</p>
      <p style="font-size:14px;margin:0;font-weight:600">${esc(draft.callToAction)}</p>
    </div>
    <div style="flex:2;background:#fffbea;border:1px solid #f0d060;border-radius:12px;padding:14px">
      <p style="font-size:13px;font-weight:600;color:#7a6000;margin:0 0 6px">📸 Hình gợi ý</p>
      <p style="font-size:14px;color:#5a4500;margin:0">${esc(draft.imageSuggestion)}</p>
    </div>
  </div>

  <div style="background:#f0f7ff;border:1px solid #b3d4f5;border-radius:12px;padding:16px;margin-bottom:20px">
    <p style="font-size:13px;font-weight:700;color:#1a4a7a;margin:0 0 10px">📋 Cách đăng (3 bước)</p>
    <ol style="margin:0;padding-left:20px;font-size:14px;color:#1a4a7a;line-height:1.8">
      <li>Mở <a href="${gbpManageUrl}" style="color:#1a6fd4;font-weight:600">Google Business Profile</a> → chọn trang ${esc(salonName)}</li>
      <li>Nhấn <strong>"Add update"</strong> → dán nội dung bên trên → thêm ảnh</li>
      <li>Chọn nút <strong>"${esc(draft.callToAction)}"</strong> → điền URL: <code style="background:#e8f0fe;padding:2px 5px;border-radius:4px;font-size:12px">${esc(bookingUrl)}</code></li>
    </ol>
  </div>

  <div style="margin-bottom:20px">
    <a href="${gbpManageUrl}" style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:13px;font-weight:600;margin-right:10px">
      Mở Google Business →
    </a>
    <a href="${gbpSearchUrl}" style="display:inline-block;background:#f1f3f4;color:#1a1a1a;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:13px;font-weight:600">
      Xem trang Google Maps
    </a>
  </div>

  <p style="font-size:11px;color:#aaa;margin:0">
    Minh · AI Manager · NailIQ · Đăng ngày ${todayYmd}
    <br>Bài kế tiếp: ${isFirstOfMonth ? "ngày 15" : "ngày 1 tháng sau"}
  </p>
</div>`,
    });

    const svc = createServiceRoleClient();
    await svc.from("ai_actions_log" as never).insert({
      salon_id: salonId,
      agent: "gbp_post",
      action_type: "sent_gbp_draft",
      payload: {
        date: todayYmd,
        period: periodLabel,
        theme,
        post_preview: draft.postText.slice(0, 150),
        cta: draft.callToAction,
        place_id: placeId,
      },
      undo_deadline: null,
    } as never);

    console.log(`[gbpPost] ${salonName}: ${theme} draft sent for ${todayYmd}`);
  } catch (e) {
    console.error("[runGbpPost]", e);
    throw e;
  }
}
