import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { sendOwnerAlert } from "@/shared/ai/sendOwnerAlert";
import type { SalonIntelligenceProfile } from "@/shared/ai/types";

/**
 * AI Yelp Review Responder — Minh's Yelp agent.
 *
 * Polls the Yelp Fusion API every 4 hours (at salon hours 8, 12, 16, 20).
 * For each new review found since last check:
 *   4–5 ★: drafts a warm, personalised reply and emails it to the owner
 *          with step-by-step instructions to post on Yelp.
 *   1–3 ★: drafts a de-escalating response and flags it with ESCALATE
 *          — owner must review and decide before posting.
 *
 * Dedup: stores review.id in ai_actions_log so the same review is never
 * re-drafted even after restarts.
 *
 * Phase 2: When Yelp Business Owner Content API becomes available (currently
 * invite-only), add OAuth auto-post (follow agentReviewResponder.ts pattern).
 *
 * Gate: feature_flags.ai_yelp_reply = true + salons.yelp_business_id non-null
 *       + YELP_API_KEY env var set.
 */

const str = (v: unknown): string => (v == null ? "" : String(v));

let anthropic: Anthropic | null = null;
function getAI(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!anthropic) anthropic = new Anthropic({ apiKey: key });
  return anthropic;
}

type YelpReview = {
  id: string;
  url: string;
  text: string;
  rating: number;
  time_created: string; // "2026-06-15 10:24:32"
  user: { name: string };
};

type YelpReviewsResponse = {
  reviews?: YelpReview[];
  total?: number;
  error?: { code: string; description: string };
};

async function fetchYelpReviews(
  businessId: string,
  apiKey: string,
): Promise<YelpReview[]> {
  const url = `https://api.yelp.com/v3/businesses/${encodeURIComponent(businessId)}/reviews?limit=50&sort_by=date`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    console.warn(`[yelpResponder] Yelp API ${res.status} for ${businessId}`);
    return [];
  }

  const body = (await res.json()) as YelpReviewsResponse;
  if (body.error) {
    console.warn("[yelpResponder] Yelp API error:", body.error.code, body.error.description);
    return [];
  }

  return body.reviews ?? [];
}

async function loadProcessedReviewIds(salonId: string): Promise<Set<string>> {
  const db = createServiceRoleClient();
  const since = new Date(Date.now() - 90 * 864e5).toISOString();

  const { data } = await db
    .from("ai_actions_log" as never)
    .select("payload" as never)
    .eq("salon_id" as never, salonId)
    .eq("agent" as never, "yelp_responder")
    .gte("created_at" as never, since);

  const ids = new Set<string>();
  for (const row of ((data ?? []) as unknown as Row[])) {
    const id = str((row.payload as Record<string, unknown> | null)?.review_id);
    if (id) ids.add(id);
  }
  return ids;
}

type DraftResult = {
  reply: string;
  tone: "positive" | "escalate";
};

async function draftReply(
  salonName: string,
  sip: Partial<SalonIntelligenceProfile> | null,
  review: YelpReview,
): Promise<DraftResult | null> {
  const ai = getAI();
  const isPositive = review.rating >= 4;

  // Fallback when no AI key
  if (!ai) {
    if (isPositive) {
      return {
        reply: `Thank you so much for the kind words, ${review.user.name || "dear guest"}! We're thrilled you had a wonderful experience at ${salonName}. Your support means the world to us — we can't wait to see you again!`,
        tone: "positive",
      };
    }
    return {
      reply: `We're truly sorry to hear your experience didn't meet your expectations, ${review.user.name || "dear guest"}. We take all feedback seriously and would love the opportunity to make it right. Please reach out to us directly so we can address your concerns personally.`,
      tone: "escalate",
    };
  }

  const lang = sip?.language_primary === "vi" ? "Vietnamese" : "English";
  const isLikelyVietnameseReview = /[À-ɏḀ-ỿ]/.test(review.text);
  const writeLang = isLikelyVietnameseReview ? "Vietnamese" : lang;

  const voiceMap: Record<string, string> = {
    warm_casual: "warm and conversational",
    warm_professional: "warm yet professional",
    luxury_formal: "gracious and polished, no exclamation marks",
    friendly_fun: "upbeat and friendly",
  };
  const voice = voiceMap[sip?.brand_voice ?? "warm_professional"] ?? "warm and professional";

  const systemPrompt = isPositive
    ? `You write genuine, personalised Yelp review replies for ${salonName}, a beauty salon.
Voice: ${voice}. Language: ${writeLang}.
Rules:
- Address the reviewer by first name (use "${review.user.name?.split(" ")[0] || "dear guest"}")
- Reference something specific from their review text
- 2-4 sentences max — Yelp readers skim
- No marketing jargon ("world-class", "best in class", "we strive to…")
- End with a genuine warm invitation to return`
    : `You write de-escalating, empathetic Yelp review replies for ${salonName}.
Voice: sincere and professional. Language: ${writeLang}.
Rules:
- Acknowledge the disappointment specifically, do not be defensive
- Apologise sincerely without admitting liability
- Offer to resolve privately (provide an invitation to contact)
- 2-4 sentences — no lengthy explanations
- Never make promises you can't keep`;

  const userPrompt = isPositive
    ? `Write a reply to this ${review.rating}★ Yelp review:\n\n"${review.text}"\n\nReply only (no labels, no quotes around it):`
    : `Write an empathetic reply to this ${review.rating}★ Yelp review:\n\n"${review.text}"\n\nReply only (no labels):`;

  try {
    const resp = await ai.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const reply = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    if (!reply) return null;
    return { reply, tone: isPositive ? "positive" : "escalate" };
  } catch {
    return null;
  }
}

export async function runYelpResponder(salonId: string): Promise<void> {
  try {
    const db = looseServiceClient();
    const { data: salon } = await db
      .from("salons" as never)
      .select(
        "name, slug, feature_flags, timezone, vertical, ai_profile, yelp_business_id" as never,
      )
      .eq("id" as never, salonId)
      .maybeSingle();

    const s = (salon as Row | null) ?? {};
    const flags = (s.feature_flags as Record<string, unknown> | null) ?? {};
    if (flags.ai_yelp_reply !== true) return;

    const yelpBusinessId = str(s.yelp_business_id);
    if (!yelpBusinessId) return;

    const yelpKey = process.env.YELP_API_KEY?.trim();
    if (!yelpKey) {
      console.warn("[yelpResponder] YELP_API_KEY not set");
      return;
    }

    const salonName = str(s.name) || "our salon";
    const sip = (s.ai_profile as Partial<SalonIntelligenceProfile> | null) ?? null;
    const slug = str(s.slug);

    const [reviews, processedIds] = await Promise.all([
      fetchYelpReviews(yelpBusinessId, yelpKey),
      loadProcessedReviewIds(salonId),
    ]);

    const newReviews = reviews.filter((r) => !processedIds.has(r.id));
    if (!newReviews.length) return;

    const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
    const bookingUrl = slug ? `${appUrl}/${slug}` : appUrl;

    // Process each new review — sequential to avoid rate-limiting AI
    for (const review of newReviews) {
      const draft = await draftReply(salonName, sip, review);
      if (!draft) continue;

      const stars = "★".repeat(review.rating) + "☆".repeat(5 - review.rating);
      const isEscalate = draft.tone === "escalate";
      const reviewUrl = review.url || `https://www.yelp.com/biz/${yelpBusinessId}`;
      const yelpReplyUrl = `https://biz.yelp.com/reviews/${yelpBusinessId}`;

      const esc = (x: string) =>
        x.replace(
          /[<>&"]/g,
          (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c),
        );

      await sendOwnerAlert(salonId, {
        subject: isEscalate
          ? `⚠️ ${salonName} — Yelp ${stars} cần xử lý từ ${review.user.name || "khách"}`
          : `${salonName} — Reply Yelp ${stars} từ Minh`,
        bodyText:
          (isEscalate ? "⚠️ ĐÁNH GIÁ CẦN CHÚ Ý — đọc kỹ trước khi đăng\n\n" : "") +
          `Review từ ${review.user.name || "khách"} (${stars}):\n` +
          `"${review.text}"\n\n` +
          `--- Reply soạn sẵn ---\n${draft.reply}\n\n` +
          `--- Cách đăng trả lời ---\n` +
          `1. Mở Yelp for Business: ${yelpReplyUrl}\n` +
          `2. Tìm review này → nhấn "Reply"\n` +
          `3. Dán nội dung trên → Submit\n\n` +
          `Xem review gốc: ${reviewUrl}\n` +
          `Trang đặt lịch: ${bookingUrl}`,
        bodyHtml: `
<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:580px;color:#1a1a1a">
  ${
    isEscalate
      ? `<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:12px;padding:14px;margin-bottom:16px">
    <p style="font-size:13px;font-weight:700;color:#856404;margin:0">⚠️ Review cần chú ý — đọc kỹ và chỉnh sửa trước khi đăng</p>
  </div>`
      : ""
  }

  <p style="font-size:12px;color:#888;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em">
    Minh · Yelp Review · ${stars}
  </p>

  <div style="background:#f9f9f9;border:1px solid #e5e5e5;border-radius:12px;padding:16px;margin-bottom:16px">
    <p style="font-size:12px;font-weight:600;color:#888;margin:0 0 6px">${esc(review.user.name || "Khách")} · ${stars}</p>
    <p style="font-size:14px;line-height:1.6;margin:0;font-style:italic;color:#555">"${esc(review.text)}"</p>
    <a href="${reviewUrl}" style="display:inline-block;margin-top:8px;font-size:11px;color:#1a6fd4">Xem trên Yelp →</a>
  </div>

  <div style="background:#f0f7ff;border:1px solid #b3d4f5;border-radius:12px;padding:16px;margin-bottom:16px">
    <p style="font-size:12px;font-weight:700;color:#1a4a7a;margin:0 0 8px">Reply soạn sẵn ${isEscalate ? "(chỉnh sửa nếu cần)" : "(copy-paste)"}</p>
    <p style="font-size:14px;line-height:1.7;margin:0;white-space:pre-wrap">${esc(draft.reply)}</p>
  </div>

  <div style="background:#f9f9f9;border:1px solid #e5e5e5;border-radius:12px;padding:14px;margin-bottom:20px">
    <p style="font-size:12px;font-weight:700;color:#555;margin:0 0 8px">📋 Cách đăng (2 bước)</p>
    <ol style="margin:0;padding-left:18px;font-size:13px;color:#444;line-height:1.8">
      <li>Mở <a href="${yelpReplyUrl}" style="color:#1a6fd4;font-weight:600">Yelp for Business</a> → tìm review này → nhấn <strong>Reply</strong></li>
      <li>Dán nội dung trên → chỉnh nếu muốn → nhấn <strong>Submit</strong></li>
    </ol>
  </div>

  <div style="margin-bottom:20px">
    <a href="${yelpReplyUrl}" style="display:inline-block;background:#d32323;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:13px;font-weight:600;margin-right:10px">
      Mở Yelp for Business →
    </a>
    <a href="${bookingUrl}" style="display:inline-block;background:#f1f3f4;color:#1a1a1a;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:13px;font-weight:600">
      Trang đặt lịch
    </a>
  </div>

  <p style="font-size:11px;color:#aaa;margin:0">Minh · AI Manager · NailIQ · ${new Date().toISOString().slice(0, 10)}</p>
</div>`,
      });

      const svc = createServiceRoleClient();
      await svc.from("ai_actions_log" as never).insert({
        salon_id: salonId,
        agent: "yelp_responder",
        action_type: isEscalate ? "escalated_negative_review" : "sent_reply_draft",
        payload: {
          review_id: review.id,
          rating: review.rating,
          reviewer: review.user.name,
          review_preview: review.text.slice(0, 120),
          tone: draft.tone,
        },
        undo_deadline: null,
      } as never);

      console.log(
        `[yelpResponder] ${salonName}: ${draft.tone} draft for ${review.rating}★ review by ${review.user.name}`,
      );
    }
  } catch (e) {
    console.error("[runYelpResponder]", e);
  }
}
