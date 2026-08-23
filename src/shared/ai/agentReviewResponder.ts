import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { createTextBackgroundAnthropicClient } from "@/shared/ai/anthropicProviderPolicy";
import {
  buildReviewReplyPrompt,
  deterministicReviewReply,
  redactReviewExcerpt,
  reviewReplyKey,
  reviewReplyLanguage,
  safeReviewerName,
  safeReviewReplyDraft,
  type ReviewReplyLanguage,
} from "@/shared/ai/reviewReplyPolicy";
import {
  isProviderTimeoutError,
  trackAnthropicMessage,
} from "@/shared/ai/usageLedger";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Google Review Responder — dashboard-only draft policy.
 *
 * The feature may read configured Google reviews and use the text provider only
 * after an atomic salon/source/review claim. Every rating creates a NailIQ
 * approval draft with dispatch disabled. Nothing here posts a public reply,
 * sends email/SMS, or calls an owner-alert delivery helper.
 */

let anthropic: Anthropic | null = null;
function getAI(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!anthropic) anthropic = createTextBackgroundAnthropicClient(key);
  return anthropic;
}

type PlaceReview = {
  author_name: string;
  rating: number;
  text: string;
  time: number;
  language?: string;
};

type PlaceDetailsResponse = {
  result?: { reviews?: PlaceReview[] };
  status: string;
  error_message?: string;
};

type PreparedReview = {
  authorName: string;
  rating: number;
  reviewExcerpt: string;
  language: ReviewReplyLanguage;
  reviewKey: string;
};

type ClaimRow = {
  outcome: "claimed" | "existing" | "in_progress" | "exhausted" | "invalid_input";
  claim_id: string | null;
  claim_token: string | null;
  attempt_count: number | null;
};

async function fetchGoogleReviews(
  placeId: string,
  apiKey: string,
): Promise<PlaceReview[]> {
  const url =
    "https://maps.googleapis.com/maps/api/place/details/json" +
    `?place_id=${encodeURIComponent(placeId)}` +
    "&fields=reviews" +
    `&key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return [];
  const body = (await response.json()) as PlaceDetailsResponse;
  if (body.status !== "OK") {
    console.warn(
      "[reviewResponder] Places API status:",
      body.status,
      body.error_message,
    );
    return [];
  }
  return body.result?.reviews ?? [];
}

function prepareReview(review: PlaceReview): PreparedReview | null {
  const rating = Number(review.rating);
  const time = Number(review.time);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null;
  if (!Number.isFinite(time) || time <= 0) return null;
  const authorName = safeReviewerName(review.author_name);
  const reviewExcerpt = redactReviewExcerpt(review.text);
  const language = reviewReplyLanguage(review.language, reviewExcerpt);
  return {
    authorName,
    rating,
    reviewExcerpt,
    language,
    reviewKey: reviewReplyKey({
      time,
      rating,
      authorName,
      reviewText: reviewExcerpt,
    }),
  };
}

async function draftReply(
  salonId: string,
  review: PreparedReview,
  salonName: string,
): Promise<string> {
  const fallback = deterministicReviewReply({
    language: review.language,
    rating: review.rating,
    salonName,
  });
  const ai = getAI();
  if (!ai) return fallback;

  const prompt = buildReviewReplyPrompt({
    language: review.language,
    rating: review.rating,
    salonName,
    reviewExcerpt: review.reviewExcerpt,
  });
  try {
    const model = "claude-sonnet-4-6";
    const response = await trackAnthropicMessage(
      { salonId, feature: "review_responder", model },
      () =>
        ai.messages.create({
          model,
          max_tokens: 300,
          system: prompt.system,
          messages: [{ role: "user", content: prompt.user }],
        }),
    );
    const candidate =
      response.content[0]?.type === "text" ? response.content[0].text : "";
    return safeReviewReplyDraft(candidate, review.language) ?? fallback;
  } catch (error) {
    if (isProviderTimeoutError(error)) throw error;
    return fallback;
  }
}

async function claimReviewDraft(
  salonId: string,
  review: PreparedReview,
): Promise<ClaimRow | null> {
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc("claim_review_reply_draft" as never, {
    p_salon_id: salonId,
    p_source: "google",
    p_review_key: review.reviewKey,
    p_content_fingerprint: review.reviewKey,
  } as never);
  if (error) throw new Error("review_reply_claim_failed", { cause: error });
  return ((data as unknown as ClaimRow[] | null) ?? [])[0] ?? null;
}

async function failReviewDraftClaim(
  claimId: string,
  claimToken: string,
  errorCode: string,
): Promise<void> {
  const db = createServiceRoleClient();
  const { error } = await db.rpc("fail_review_reply_draft" as never, {
    p_claim_id: claimId,
    p_claim_token: claimToken,
    p_error_code: errorCode,
  } as never);
  if (error) console.error("[reviewResponder] fail claim", error);
}

async function completeReviewDraft(
  claimId: string,
  claimToken: string,
  review: PreparedReview,
  draft: string,
): Promise<boolean> {
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc("complete_review_reply_draft" as never, {
    p_claim_id: claimId,
    p_claim_token: claimToken,
    p_reviewer_name: review.authorName,
    p_rating: review.rating,
    p_review_excerpt: review.reviewExcerpt,
    p_draft_reply: draft,
    p_language: review.language,
  } as never);
  if (error) throw new Error("review_reply_complete_failed", { cause: error });
  const row = ((data as unknown as Array<{ outcome?: unknown }> | null) ?? [])[0];
  return row?.outcome === "created" || row?.outcome === "existing";
}

export async function runReviewResponder(salonId: string): Promise<void> {
  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
    if (!apiKey) return;

    const db = looseServiceClient();
    const { data: salon, error: salonError } = await db
      .from("salons" as never)
      .select("name, feature_flags, google_place_id" as never)
      .eq("id" as never, salonId)
      .maybeSingle();
    if (salonError) throw new Error("review_responder_salon_read_failed");

    const row = (salon as Row | null) ?? {};
    const flags = (row.feature_flags as Record<string, unknown> | null) ?? {};
    if (flags.ai_google_reply !== true) return;
    const placeId = String(row.google_place_id ?? "").trim();
    if (!placeId) return;
    const salonName = String(row.name ?? "our salon").trim() || "our salon";

    const reviews = await fetchGoogleReviews(placeId, apiKey);
    let normalDrafts = 0;
    let urgentDrafts = 0;

    for (const rawReview of reviews) {
      const review = prepareReview(rawReview);
      if (!review) continue;
      const claim = await claimReviewDraft(salonId, review);
      if (
        claim?.outcome !== "claimed" ||
        !claim.claim_id ||
        !claim.claim_token
      ) {
        continue;
      }

      try {
        const draft = await draftReply(salonId, review, salonName);
        const completed = await completeReviewDraft(
          claim.claim_id,
          claim.claim_token,
          review,
          draft,
        );
        if (!completed) throw new Error("review_reply_complete_rejected");
        if (review.rating <= 3) urgentDrafts += 1;
        else normalDrafts += 1;
      } catch (error) {
        await failReviewDraftClaim(
          claim.claim_id,
          claim.claim_token,
          isProviderTimeoutError(error)
            ? "provider_timeout"
            : "draft_generation_failed",
        );
        throw error;
      }
    }

    console.log(
      `[reviewResponder] ${salonName}: ${normalDrafts} normal dashboard drafts, ${urgentDrafts} urgent dashboard drafts`,
    );
  } catch (e) {
    console.error("[runReviewResponder]", e);
    throw e;
  }
}
