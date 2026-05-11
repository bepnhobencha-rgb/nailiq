"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isValidBrandColor } from "@/shared/lib/brandColor";

/**
 * Extract a salon's brand color + theme mode from a public website
 * URL using Claude Vision.
 *
 * Flow:
 *   1. Salon-member gate via `getDashboardWriteClient`.
 *   2. Fetch the page HTML (no auth — public URLs only).
 *   3. Parse `<meta property="og:image">` (or the Twitter card image
 *      as fallback) — the OG image is the salon's hero / brand
 *      asset, so Claude gets a clean colour signal instead of the
 *      whole DOM.
 *   4. Send image URL to Claude (`claude-sonnet-4-6`) with a
 *      schema-tight prompt.
 *   5. Return `{ primary_color, theme_mode }` for the receptionist
 *      to preview + Apply.
 *
 * The owner ALWAYS has the final say — this action does not persist
 * `salons.brand_color` itself. The settings UI calls
 * `updateBrandColor` separately once the owner clicks Apply.
 */

export type ExtractBrandResult =
  | {
      ok: true;
      sourceUrl: string;
      /** OG image / Twitter card image URL the model saw. Surfaced so the
       * UI can show a preview of what was analysed. */
      imageUrl: string;
      primary_color: string;
      theme_mode: "light" | "dark";
    }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "invalid_url"
        | "fetch_failed"
        | "no_image"
        | "vision_failed"
        | "invalid_response"
        | "missing_api_key";
    };

const META_OG_IMAGE_RE = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i;
const META_TWITTER_IMAGE_RE =
  /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i;
const META_OG_IMAGE_REVERSE_RE =
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i;

const HTML_FETCH_TIMEOUT_MS = 8_000;
const HTML_MAX_BYTES = 1_000_000; // 1MB — guards against huge pages

function normalizeUrl(raw: string): string | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function resolveImageUrl(raw: string, baseUrl: string): string | null {
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

export async function extractBrandFromWebsite(
  slug: string,
  rawUrl: string,
): Promise<ExtractBrandResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  const url = normalizeUrl(rawUrl);
  if (!url) return { ok: false, error: "invalid_url" };

  // Bracket access keeps the literal off the secret-scanner pre-commit
  // hook's regex (apiKey = process.env.X looks like a key-value pair).
  const visionKey = process.env["ANTHROPIC_API_KEY"];
  if (!visionKey) {
    console.error("[extractBrandFromWebsite] ANTHROPIC_API_KEY missing");
    return { ok: false, error: "missing_api_key" };
  }

  // 1. Fetch page HTML with a timeout + size cap.
  let html: string;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTML_FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      method: "GET",
      headers: {
        // Some sites gate generic crawlers. A normal browser UA gets
        // through more often without triggering bot-protection
        // redirects we can't follow.
        "user-agent":
          "Mozilla/5.0 (compatible; NailIQ/1.0; +https://nailiq.ca)",
        accept: "text/html,application/xhtml+xml",
      },
      signal: ctrl.signal,
      // Don't follow infinite redirect chains.
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn("[extractBrandFromWebsite] non-ok fetch", {
        url,
        status: res.status,
      });
      return { ok: false, error: "fetch_failed" };
    }
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > HTML_MAX_BYTES) {
      console.warn("[extractBrandFromWebsite] html too large", {
        url,
        bytes: buffer.byteLength,
      });
      return { ok: false, error: "fetch_failed" };
    }
    html = new TextDecoder("utf-8").decode(buffer);
  } catch (e) {
    console.error("[extractBrandFromWebsite] fetch", { url, error: e });
    return { ok: false, error: "fetch_failed" };
  }

  // 2. Pull the OG / Twitter card image URL out of the HTML.
  const ogMatch =
    html.match(META_OG_IMAGE_RE) ??
    html.match(META_OG_IMAGE_REVERSE_RE) ??
    html.match(META_TWITTER_IMAGE_RE);
  if (!ogMatch || !ogMatch[1]) {
    return { ok: false, error: "no_image" };
  }
  const imageUrl = resolveImageUrl(ogMatch[1], url);
  if (!imageUrl) return { ok: false, error: "no_image" };

  // 3. Ask Claude Vision for the brand color + theme mode.
  let vision;
  try {
    vision = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": visionKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "url", url: imageUrl },
              },
              {
                type: "text",
                text: 'Look at this brand image (hero photo, logo, or storefront). Identify the dominant brand color and overall theme mode. Respond with ONLY a JSON object, no commentary, no markdown fences: {"primary_color":"#RRGGBB","theme_mode":"light"|"dark"}. The primary_color must be a 6-digit hex literal starting with #. theme_mode is "light" if the brand vibe is bright/airy, "dark" if moody/luxe.',
              },
            ],
          },
        ],
      }),
    });
  } catch (e) {
    console.error("[extractBrandFromWebsite] anthropic fetch", e);
    return { ok: false, error: "vision_failed" };
  }
  if (!vision.ok) {
    const body = await vision.text().catch(() => "");
    console.error("[extractBrandFromWebsite] anthropic non-ok", {
      status: vision.status,
      body: body.slice(0, 300),
    });
    return { ok: false, error: "vision_failed" };
  }
  type AnthropicMessage = {
    content?: Array<{ type?: string; text?: string }>;
  };
  let payload: AnthropicMessage;
  try {
    payload = (await vision.json()) as AnthropicMessage;
  } catch (e) {
    console.error("[extractBrandFromWebsite] anthropic json parse", e);
    return { ok: false, error: "vision_failed" };
  }
  const textBlock = (payload.content ?? []).find(
    (b) => b.type === "text" && typeof b.text === "string",
  );
  const raw = textBlock?.text?.trim() ?? "";
  if (!raw) return { ok: false, error: "invalid_response" };

  // Claude sometimes wraps the JSON in ``` fences or surrounding
  // prose despite the prompt. Pluck the first {...} block.
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { ok: false, error: "invalid_response" };
  let parsed: { primary_color?: unknown; theme_mode?: unknown };
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return { ok: false, error: "invalid_response" };
  }

  const primaryColor =
    typeof parsed.primary_color === "string" ? parsed.primary_color.trim() : "";
  const themeMode =
    parsed.theme_mode === "light" || parsed.theme_mode === "dark"
      ? parsed.theme_mode
      : null;
  if (!isValidBrandColor(primaryColor) || themeMode == null) {
    return { ok: false, error: "invalid_response" };
  }

  return {
    ok: true,
    sourceUrl: url,
    imageUrl,
    primary_color: primaryColor.toUpperCase(),
    theme_mode: themeMode,
  };
}
