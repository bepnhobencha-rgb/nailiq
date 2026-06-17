import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { sendOwnerAlert } from "@/shared/ai/sendOwnerAlert";

/**
 * AI Review Responder — polls Google Places API for new reviews, drafts replies,
 * and routes them based on star rating.
 *
 * 4–5 ★: AUTO — AI drafts reply, alerts owner with the text ready to post.
 *   (Requires Google Business Profile OAuth for true auto-post; current impl
 *   delivers a ready-to-copy draft until OAuth is wired up in a future phase.)
 *
 * 1–3 ★: ESCALATE — AI drafts + owner alert emphasising human response needed.
 *   NEVER auto-posts for negative reviews.
 *
 * Dedup: stores review.time (Unix timestamp) in ai_actions_log payload so we
 * never re-draft the same review.
 *
 * Gate: salons.google_place_id is non-null + GOOGLE_MAPS_API_KEY env is set.
 */

let anthropic: Anthropic | null = null;
function getAI(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!anthropic) anthropic = new Anthropic({ apiKey: key });
  return anthropic;
}

type PlaceReview = {
  author_name: string;
  rating: number;
  text: string;
  time: number; // Unix seconds
  language?: string;
};

type PlaceDetailsResponse = {
  result?: {
    reviews?: PlaceReview[];
  };
  status: string;
  error_message?: string;
};

async function fetchGoogleReviews(placeId: string, apiKey: string): Promise<PlaceReview[]> {
  const url =
    `https://maps.googleapis.com/maps/api/place/details/json` +
    `?place_id=${encodeURIComponent(placeId)}` +
    `&fields=reviews` +
    `&key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return [];

  const body = (await res.json()) as PlaceDetailsResponse;
  if (body.status !== "OK") {
    console.warn("[reviewResponder] Places API status:", body.status, body.error_message);
    return [];
  }
  return body.result?.reviews ?? [];
}

async function loadProcessedReviewTimes(salonId: string): Promise<Set<number>> {
  const db = createServiceRoleClient();
  const since = new Date(Date.now() - 90 * 864e5).toISOString(); // last 90 days
  const { data } = await db
    .from("ai_actions_log" as never)
    .select("payload" as never)
    .eq("salon_id" as never, salonId)
    .eq("agent" as never, "review_responder")
    .gte("created_at" as never, since);

  const times = new Set<number>();
  for (const row of (data ?? []) as unknown as Row[]) {
    const rt = (row.payload as Record<string, unknown> | null)?.review_time;
    if (typeof rt === "number") times.add(rt);
  }
  return times;
}

async function draftReply(
  review: PlaceReview,
  salonName: string,
  lang: string,
): Promise<string> {
  const ai = getAI();
  const isPositive = review.rating >= 4;

  if (!ai) {
    return isPositive
      ? `Thank you so much for your wonderful review, ${review.author_name}! We're so glad you enjoyed your experience at ${salonName} and we look forward to seeing you again.`
      : `Thank you for taking the time to share your feedback, ${review.author_name}. We sincerely apologise for falling short of your expectations and would love the opportunity to make it right. Please reach out to us directly.`;
  }

  const tone = isPositive ? "warm, grateful, genuine" : "sincere, apologetic, solution-oriented";
  const instruction = isPositive
    ? "Thank the reviewer warmly. Mention their name. Reference any specific detail they mentioned. Invite them back."
    : "Acknowledge their concern genuinely. Do NOT be defensive. Offer to resolve it directly. Include a direct contact option if possible.";

  const prompt = `You are a professional owner of ${salonName} replying to a Google review.

Review (${review.rating} stars, language hint: ${lang || "auto-detect"}):
"""
${review.text || "(no text provided)"}
"""
Reviewer: ${review.author_name}

Write a ${tone} reply in the SAME language as the review. ${instruction}
Keep it to 2-3 sentences. No hashtags. No emojis unless the review used them. No generic corporate phrases.
Return ONLY the reply text.`;

  try {
    const resp = await anthropic!.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    const clean = text.replace(/^["']|["']$/g, "").trim();
    return clean.length > 10 ? clean : "";
  } catch {
    return "";
  }
}

export async function runReviewResponder(salonId: string): Promise<void> {
  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
    if (!apiKey) return;

    const db = looseServiceClient();
    const { data: salon } = await db
      .from("salons" as never)
      .select("name, google_place_id" as never)
      .eq("id" as never, salonId)
      .maybeSingle();

    const s = (salon as Row | null) ?? {};
    const placeId = String(s.google_place_id ?? "").trim();
    if (!placeId) return;

    const salonName = String(s.name ?? "our salon");

    const [reviews, processed] = await Promise.all([
      fetchGoogleReviews(placeId, apiKey),
      loadProcessedReviewTimes(salonId),
    ]);

    const fresh = reviews.filter((r) => !processed.has(r.time));
    if (fresh.length === 0) return;

    const svc = createServiceRoleClient();
    let positive = 0;
    let negative = 0;

    for (const review of fresh) {
      const isPositive = review.rating >= 4;
      const draft = await draftReply(review, salonName, review.language ?? "");
      if (!draft) continue;

      const actionType = isPositive ? "draft_review_reply" : "escalate_review_reply";
      const stars = "★".repeat(review.rating) + "☆".repeat(5 - review.rating);

      await svc.from("ai_actions_log" as never).insert({
        salon_id: salonId,
        agent: "review_responder",
        action_type: actionType,
        payload: {
          review_time: review.time,
          author: review.author_name,
          rating: review.rating,
          review_text: review.text?.slice(0, 500),
          draft_reply: draft,
        },
        // Review responses are informational — no undo window
        undo_deadline: null,
      } as never);

      if (isPositive) {
        positive++;
        await sendOwnerAlert(salonId, {
          subject: `${salonName} — New ${review.rating}★ review from ${review.author_name}`,
          bodyText:
            `Có đánh giá mới ${stars} từ "${review.author_name}".\n\n` +
            `Review: "${review.text?.slice(0, 300) ?? "(no text)"}"\n\n` +
            `AI đề xuất reply:\n"${draft}"\n\n` +
            `Vào Google Business Profile để đăng reply này.`,
          bodyHtml: `
<div style="font-family:-apple-system,sans-serif;max-width:560px;color:#1a1a1a">
  <p style="font-size:15px;font-weight:600;margin:0 0 8px">${stars} ${review.author_name}</p>
  <blockquote style="border-left:3px solid #ddd;margin:0 0 16px;padding:8px 12px;color:#555;font-style:italic">"${review.text?.slice(0, 300) ?? "(no text)"}"</blockquote>
  <p style="font-size:13px;font-weight:600;margin:0 0 6px;color:#1a1a1a">AI đề xuất reply:</p>
  <p style="background:#f5f5f5;border-radius:8px;padding:12px;font-size:14px;margin:0 0 16px">${draft}</p>
  <p style="font-size:12px;color:#888">Vào Google Business Profile để đăng reply này. AI đề xuất — hãy chỉnh sửa trước khi đăng nếu cần.</p>
</div>`,
        });
      } else {
        negative++;
        await sendOwnerAlert(salonId, {
          subject: `⚠️ ${salonName} — ${review.rating}★ review cần xử lý`,
          bodyText:
            `CẦN PHẢN HỒI: Review ${stars} từ "${review.author_name}".\n\n` +
            `Review: "${review.text?.slice(0, 500) ?? "(no text)"}"\n\n` +
            `AI đề xuất nháp (chỉnh sửa theo thực tế trước khi đăng):\n"${draft}"\n\n` +
            `QUAN TRỌNG: AI không tự đăng reply cho review dưới 4 sao. Hãy phản hồi cá nhân, chuyên nghiệp.`,
          bodyHtml: `
<div style="font-family:-apple-system,sans-serif;max-width:560px;color:#1a1a1a">
  <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:12px;margin:0 0 16px">
    <p style="color:#dc2626;font-weight:700;margin:0">⚠️ Review xấu cần phản hồi thủ công</p>
    <p style="color:#dc2626;font-size:12px;margin:4px 0 0">AI KHÔNG tự đăng reply cho review dưới 4 sao</p>
  </div>
  <p style="font-size:15px;font-weight:600;margin:0 0 8px">${stars} ${review.author_name}</p>
  <blockquote style="border-left:3px solid #fca5a5;margin:0 0 16px;padding:8px 12px;color:#555;font-style:italic">"${review.text?.slice(0, 500) ?? "(no text)"}"</blockquote>
  <p style="font-size:13px;font-weight:600;margin:0 0 6px">AI đề xuất nháp (chỉnh sửa trước khi dùng):</p>
  <p style="background:#f5f5f5;border-radius:8px;padding:12px;font-size:14px;margin:0 0 16px">${draft}</p>
  <p style="font-size:12px;color:#888">Vào Google Business Profile để đăng reply đã chỉnh sửa.</p>
</div>`,
        });
      }
    }

    console.log(`[reviewResponder] ${salonName}: +${positive} positive, !${negative} negative`);
  } catch (e) {
    console.error("[runReviewResponder]", e);
  }
}
