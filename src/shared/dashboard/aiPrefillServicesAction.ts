"use server";

import { z } from "zod";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import {
  canAddService,
  parseSubscriptionPlan,
  getEffectivePlanLimits,
} from "@/shared/lib/subscriptionPlans";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExtractedService = {
  name: string;
  price_cents: number | null;
  duration_minutes: number;
};

export type AnalyzeMenuResult =
  | { ok: true; services: ExtractedService[] }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "missing_api_key"
        | "vision_failed"
        | "invalid_response"
        | "invalid_url"
        | "payload_too_large";
    };

export type BulkImportResult =
  | { ok: true; imported: number }
  | { ok: false; error: "unauthorized" | "plan_limit" | "server_error" };

// ---------------------------------------------------------------------------
// Zod schema for Claude's JSON output
// ---------------------------------------------------------------------------

const ExtractedServiceSchema = z.object({
  name: z.string().min(1).max(120),
  price_cents: z.number().int().nonnegative().nullable(),
  duration_minutes: z.number().int().positive(),
});

const ExtractedServicesArraySchema = z.array(ExtractedServiceSchema).max(60);

// ---------------------------------------------------------------------------
// Shared prompt
// ---------------------------------------------------------------------------

const MENU_EXTRACTION_PROMPT = `This is a nail salon menu or price list image.
Extract every service you can clearly see.

Return ONLY a JSON array with no markdown fences or commentary:
[{"name":"Gel Manicure","price_cents":3500,"duration_minutes":30},...]

Rules:
- name: English, properly capitalized (max 80 chars). Translate Vietnamese service names to English.
- price_cents: integer (e.g. $35.00 → 3500, $35 → 3500). Use null if price is not clearly shown.
- duration_minutes: integer. Estimate standard times if not shown in menu:
  gel manicure=30, regular manicure=25, gel pedicure=50, regular pedicure=40,
  acrylic full set=60, acrylic fill=45, dip powder=50,
  gel removal=15, acrylic removal=20, nail art=15, polish change=15, french tips=10.
- Skip add-ons priced under $3. Skip vague entries like "other" or "ask for price".
- If no clear menu or price list is visible in the image, return [].`;

// ---------------------------------------------------------------------------
// Anthropic fetch helper (raw fetch, same pattern as extractBrandFromWebsiteAction)
// ---------------------------------------------------------------------------

type AnthropicMessage = {
  content?: Array<{ type?: string; text?: string }>;
};

async function callClaudeVision(
  imageContent:
    | { type: "url"; url: string }
    | { type: "base64"; media_type: string; data: string },
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    console.error("[aiPrefillServices] ANTHROPIC_API_KEY missing");
    return { ok: false, error: "missing_api_key" };
  }

  const imageBlock =
    imageContent.type === "url"
      ? { type: "image", source: { type: "url", url: imageContent.url } }
      : {
          type: "image",
          source: {
            type: "base64",
            media_type: imageContent.media_type,
            data: imageContent.data,
          },
        };

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: [
              imageBlock,
              { type: "text", text: MENU_EXTRACTION_PROMPT },
            ],
          },
        ],
      }),
    });
  } catch (e) {
    console.error("[aiPrefillServices] fetch error", e);
    return { ok: false, error: "vision_failed" };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[aiPrefillServices] non-ok", res.status, body.slice(0, 300));
    return { ok: false, error: "vision_failed" };
  }

  let payload: AnthropicMessage;
  try {
    payload = (await res.json()) as AnthropicMessage;
  } catch (e) {
    console.error("[aiPrefillServices] json parse", e);
    return { ok: false, error: "vision_failed" };
  }

  const textBlock = (payload.content ?? []).find(
    (b) => b.type === "text" && typeof b.text === "string",
  );
  const text = textBlock?.text?.trim() ?? "";
  if (!text) return { ok: false, error: "invalid_response" };

  return { ok: true, text };
}

function parseClaudeResponse(raw: string): ExtractedService[] | null {
  // Claude sometimes wraps JSON in ``` fences despite the prompt
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const result = ExtractedServicesArraySchema.safeParse(parsed);
    if (!result.success) return null;
    return result.data.map((s) => ({
      name: s.name.trim(),
      price_cents: s.price_cents,
      duration_minutes: s.duration_minutes,
    }));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public server actions
// ---------------------------------------------------------------------------

/**
 * Analyze a menu image from a base64-encoded file upload.
 * The slug gate ensures only salon members can call this.
 * Image bytes are sent to Anthropic and immediately discarded — not stored.
 */
export async function analyzeMenuImage(
  slug: string,
  base64Data: string,
  mimeType: string,
): Promise<AnalyzeMenuResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  // ~4MB base64 ≈ 3MB binary; Anthropic accepts up to 5MB
  const MAX_BASE64_LEN = 6_000_000;
  if (base64Data.length > MAX_BASE64_LEN) {
    return { ok: false, error: "payload_too_large" };
  }

  const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const safeMime = allowed.includes(mimeType) ? mimeType : "image/jpeg";

  const vision = await callClaudeVision({
    type: "base64",
    media_type: safeMime,
    data: base64Data,
  });

  if (!vision.ok) {
    return {
      ok: false,
      error: vision.error as Extract<AnalyzeMenuResult, { ok: false }>["error"],
    };
  }

  const services = parseClaudeResponse(vision.text);
  if (services === null) return { ok: false, error: "invalid_response" };

  return { ok: true, services };
}

/**
 * Analyze a menu image from a publicly accessible URL.
 * Anthropic fetches the image from their network — no SSRF surface on our end.
 */
export async function analyzeMenuImageUrl(
  slug: string,
  rawUrl: string,
): Promise<AnalyzeMenuResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  // Validate URL (http/https only)
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed) return { ok: false, error: "invalid_url" };
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let imageUrl: string;
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, error: "invalid_url" };
    }
    imageUrl = u.toString();
  } catch {
    return { ok: false, error: "invalid_url" };
  }

  const vision = await callClaudeVision({ type: "url", url: imageUrl });
  if (!vision.ok) {
    return {
      ok: false,
      error: vision.error as Extract<AnalyzeMenuResult, { ok: false }>["error"],
    };
  }

  const services = parseClaudeResponse(vision.text);
  if (services === null) return { ok: false, error: "invalid_response" };

  return { ok: true, services };
}

/**
 * Bulk-insert AI-extracted services for a salon.
 * Membership-gated. Respects plan `maxServices` limit.
 * `buffer_minutes` defaults to 10 (same as seed services).
 */
export async function bulkImportAIServices(
  slug: string,
  services: ExtractedService[],
): Promise<BulkImportResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  if (services.length === 0) return { ok: true, imported: 0 };

  // Check plan limit
  const { data: planRow } = await ctx.supabase
    .from("salons")
    .select("subscription_plan, plan_override" as never)
    .eq("id", ctx.salon.id)
    .maybeSingle();

  const planLimits = getEffectivePlanLimits(
    (planRow ?? {}) as {
      subscription_plan?: string | null;
      plan_override?: string | null;
    },
  );

  const { count: existingCount } = await ctx.supabase
    .from("services")
    .select("id", { count: "exact", head: true })
    .eq("salon_id", ctx.salon.id)
    .is("deleted_at" as never, null);

  const currentCount = existingCount ?? 0;
  const maxServices = Number.isFinite(planLimits.maxServices)
    ? planLimits.maxServices
    : 999;

  const available = Math.max(0, maxServices - currentCount);
  if (available === 0) return { ok: false, error: "plan_limit" };

  // Truncate to available slots
  const toInsert = services.slice(0, available).map((svc) => ({
    salon_id: ctx.salon.id,
    name: svc.name.slice(0, 160),
    price_cents: svc.price_cents ?? 0,
    duration_minutes: Math.max(1, svc.duration_minutes),
    buffer_minutes: 10,
  }));

  const { error } = await ctx.supabase
    .from("services")
    .insert(toInsert as never);

  if (error) {
    console.error("[bulkImportAIServices]", error);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, imported: toInsert.length };
}
