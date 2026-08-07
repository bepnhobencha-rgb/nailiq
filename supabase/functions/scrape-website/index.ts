// Supabase Edge Function — scrape-website
// Accepts POST { jobId, sourceUrl, salonId, salonSlug, salonEmail }
// Called fire-and-forget from /api/import-website with a service-role Bearer credential.
// Pipeline: fetch HTML → Claude extract → download images → upsert salon/services/sections → email.

import { createClient } from "npm:@supabase/supabase-js@2";
import { rejectUnauthorizedInternalRequest } from "../_shared/internalAuth.ts";
import { safeOutboundFetch } from "../_shared/safeOutboundFetch.ts";
import { supabaseSecretKey } from "../_shared/supabaseApiKeys.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = supabaseSecretKey();
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const RESEND_FROM = Deno.env.get("RESEND_FROM") ?? "NailIQ <noreply@nailiq.ca>";
const SITE_URL = (Deno.env.get("NEXT_PUBLIC_SITE_URL") ?? "https://nailiq.ca").replace(/\/$/, "");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

type JobStatus = "pending" | "scraping" | "extracting" | "building" | "done" | "failed";

async function updateJob(
  db: ReturnType<typeof createClient>,
  jobId: string,
  patch: { status?: JobStatus; progress?: number; result?: unknown; error_message?: string },
) {
  await db
    .from("website_import_jobs")
    .update(patch as never)
    .eq("id", jobId);
}

// ─── Image download + Storage upload ─────────────────────────────────────────

async function downloadImageToStorage(
  db: ReturnType<typeof createClient>,
  imageUrl: string,
  salonId: string,
  label: string,
): Promise<string | null> {
  try {
    const res = await safeOutboundFetch(imageUrl, {
      headers: { "User-Agent": "NailIQ-Importer/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowed.includes(contentType.split(";")[0].trim())) return null;

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > 5 * 1024 * 1024) return null; // 5 MB limit

    const ext = contentType.includes("png")
      ? "png"
      : contentType.includes("webp")
        ? "webp"
        : contentType.includes("gif")
          ? "gif"
          : "jpg";
    const path = `${salonId}/${label}-${Date.now()}.${ext}`;

    const { error } = await db.storage
      .from("salon-imports")
      .upload(path, buffer, { contentType: contentType.split(";")[0].trim(), upsert: true });

    if (error) return null;

    return db.storage.from("salon-imports").getPublicUrl(path).data.publicUrl;
  } catch {
    return null;
  }
}

// ─── HTML scraper ─────────────────────────────────────────────────────────────

function extractText(html: string): string {
  // Strip scripts, styles, nav, footer noise
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return text.slice(0, 12000);
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : "";
}

function extractMetaDescription(html: string): string {
  const m = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
  return m ? m[1].trim() : "";
}

function extractImages(html: string, baseUrl: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  const re = /<img[^>]+src=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const url = new URL(m[1], baseUrl).href;
      if (!seen.has(url)) {
        seen.add(url);
        results.push(url);
      }
    } catch {
      // invalid URL — skip
    }
  }
  return results.slice(0, 20);
}

function extractOgImage(html: string, baseUrl: string): string | null {
  const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (!m) return null;
  try {
    return new URL(m[1], baseUrl).href;
  } catch {
    return null;
  }
}

// ─── Claude extraction ────────────────────────────────────────────────────────

type ExtractedSalon = {
  name: string;
  description: string;
  address: string;
  phone: string;
  email: string;
  brand_color: string;
  hero_tagline: string;
  services: Array<{
    name: string;
    price_cents: number;
    duration_minutes: number;
    category: string;
  }>;
  gallery_captions: string[];
};

async function extractWithClaude(
  pageTitle: string,
  metaDesc: string,
  bodyText: string,
): Promise<ExtractedSalon> {
  const prompt = `You are extracting structured data from a nail salon website to populate a booking platform.

Page title: ${pageTitle}
Meta description: ${metaDesc}
Page text (truncated):
---
${bodyText}
---

Return ONLY a valid JSON object matching this exact shape — no markdown, no explanation:
{
  "name": "Salon name",
  "description": "1-2 sentence description of the salon",
  "address": "Full street address or empty string",
  "phone": "Phone number or empty string",
  "email": "Email or empty string",
  "brand_color": "#hexcolor or empty string (pick from logo/brand if visible)",
  "hero_tagline": "Short 1-line tagline for the hero section",
  "services": [
    {
      "name": "Service name",
      "price_cents": 3000,
      "duration_minutes": 60,
      "category": "one of: manicure | pedicure | acrylic | gel | dip_powder | waxing | other"
    }
  ],
  "gallery_captions": ["caption1", "caption2"]
}

Rules:
- price_cents: integer cents (e.g. $30.00 → 3000). Use 0 if price is not listed.
- duration_minutes: integer. Use 60 as default if not listed.
- category: must be one of the exact slugs listed above.
- services: extract up to 15 services. Deduplicate.
- gallery_captions: up to 5 short image alt captions for a photo gallery section.
- brand_color: valid 6-digit hex with #, or empty string "".
- All string fields: empty string "" if unknown, never null.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const raw: string = data.content?.[0]?.text ?? "{}";

  // Strip any accidental markdown fences
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
  const parsed = JSON.parse(cleaned) as ExtractedSalon;
  return parsed;
}

// ─── Builder: upsert salon + sections + services ──────────────────────────────

async function buildSalon(
  db: ReturnType<typeof createClient>,
  salonId: string,
  extracted: ExtractedSalon,
  logoUrl: string | null,
  heroUrl: string | null,
  galleryUrls: string[],
) {
  const salonPatch: Record<string, unknown> = {};
  if (extracted.name) salonPatch["name"] = extracted.name;
  if (extracted.description) salonPatch["description"] = extracted.description;
  if (extracted.address) salonPatch["address"] = extracted.address;
  if (extracted.phone) salonPatch["phone"] = extracted.phone;
  if (extracted.email) salonPatch["email"] = extracted.email;
  if (extracted.brand_color?.match(/^#[0-9a-fA-F]{6}$/)) {
    salonPatch["brand_color"] = extracted.brand_color;
  }
  // logo_url / hero_image_url do not exist on salons — images go into page sections below

  if (Object.keys(salonPatch).length > 0) {
    await db.from("salons").update(salonPatch).eq("id", salonId);
  }

  // Upsert services (max 15, skip duplicates by name)
  const seen = new Set<string>();
  for (const svc of (extracted.services ?? []).slice(0, 15)) {
    const key = svc.name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const validCategories = ["manicure", "pedicure", "acrylic", "gel", "dip_powder", "waxing", "other"];
    // Normalise common Claude variants (gel_manicure → gel, dip → dip_powder, etc.)
    const normalised = svc.category
      .replace("gel_manicure", "gel")
      .replace("gel_pedicure", "gel")
      .replace(/^dip$/, "dip_powder")
      .replace("nail_art", "other")
      .replace("eyebrow", "waxing")
      .replace("threading", "waxing");
    const category = validCategories.includes(normalised) ? normalised : "other";

    await db.from("services").insert({
      salon_id: salonId,
      name: svc.name.trim(),
      price_cents: Math.max(0, Math.round(svc.price_cents ?? 0)),
      duration_minutes: Math.max(15, Math.round(svc.duration_minutes ?? 60)),
      category,
    } as never);
  }

  // Upsert page sections (hero, gallery)
  await db.rpc("seed_default_page_sections" as never, { p_salon_id: salonId } as never);

  // Update hero section
  if (extracted.hero_tagline || heroUrl) {
    const { data: heroSection } = await db
      .from("salon_page_sections" as never)
      .select("id, content")
      .eq("salon_id", salonId)
      .eq("type", "hero")
      .maybeSingle();

    if (heroSection) {
      const existing = (heroSection as { content: Record<string, unknown> }).content ?? {};
      const patch: Record<string, unknown> = { ...existing };
      if (extracted.hero_tagline) patch["tagline"] = extracted.hero_tagline;
      if (heroUrl) patch["background_url"] = heroUrl;
      await db
        .from("salon_page_sections" as never)
        .update({ content: patch } as never)
        .eq("id", (heroSection as { id: string }).id);
    }
  }

  // Update gallery section
  if (galleryUrls.length > 0) {
    const { data: gallerySection } = await db
      .from("salon_page_sections" as never)
      .select("id, content")
      .eq("salon_id", salonId)
      .eq("type", "gallery")
      .maybeSingle();

    if (gallerySection) {
      const existing = (gallerySection as { content: Record<string, unknown> }).content ?? {};
      const captions = (extracted.gallery_captions ?? []).slice(0, galleryUrls.length);
      const items = galleryUrls.map((url, i) => ({
        url,
        caption: captions[i] ?? "",
      }));
      await db
        .from("salon_page_sections" as never)
        .update({ content: { ...existing, items } } as never)
        .eq("id", (gallerySection as { id: string }).id);
    }
  }
}

// ─── Email notification ───────────────────────────────────────────────────────

async function sendCompletionEmail(
  salonEmail: string,
  salonSlug: string,
  salonName: string,
  serviceCount: number,
) {
  if (!RESEND_API_KEY) return;
  const dashboardUrl = `${SITE_URL}/dashboard/${salonSlug}/settings/my-page`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: salonEmail,
      subject: `Your NailIQ page is ready — ${salonName}`,
      html: `<p>Hi,</p>
<p>We finished importing your website into NailIQ. Here's what was set up:</p>
<ul>
  <li>Salon profile updated (name, description, address, phone)</li>
  <li>${serviceCount} service${serviceCount !== 1 ? "s" : ""} added to your menu</li>
  <li>Hero section and gallery populated with your images</li>
</ul>
<p>Review and fine-tune everything here:<br>
<a href="${dashboardUrl}">${dashboardUrl}</a></p>
<p>— The NailIQ team</p>`,
    }),
  });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonRes({ error: "method_not_allowed" }, 405);

  const unauthorized = await rejectUnauthorizedInternalRequest(req, corsHeaders);
  if (unauthorized) return unauthorized;

  // Emergency fail-closed kill switch. The importer performs outbound fetches
  // and must remain disabled until its SSRF defenses pass penetration tests.
  if (Deno.env.get("WEBSITE_IMPORT_ENABLED") !== "true") {
    return jsonRes({ error: "website_import_disabled" }, 503);
  }

  let body: { jobId: string; sourceUrl: string; salonId: string; salonSlug: string; salonEmail: string };
  try {
    body = await req.json();
  } catch {
    return jsonRes({ error: "invalid_json" }, 400);
  }

  const { jobId, sourceUrl, salonId, salonSlug, salonEmail } = body;
  if (!jobId || !sourceUrl || !salonId) {
    return jsonRes({ error: "missing_fields" }, 400);
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Respond immediately — long-running work happens below in the same isolate
  // (Supabase Edge Functions are not streaming, so we run inline and return at end)

  try {
    // ── 1. Scraping ────────────────────────────────────────────────────────
    await updateJob(db, jobId, { status: "scraping", progress: 10 });

    const htmlRes = await safeOutboundFetch(sourceUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; NailIQ-Importer/1.0; +https://nailiq.ca)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!htmlRes.ok) {
      throw new Error(`HTTP ${htmlRes.status} fetching ${sourceUrl}`);
    }

    const html = await htmlRes.text();
    const pageTitle = extractTitle(html);
    const metaDesc = extractMetaDescription(html);
    const bodyText = extractText(html);
    const imgUrls = extractImages(html, sourceUrl);
    const ogImageUrl = extractOgImage(html, sourceUrl);

    await updateJob(db, jobId, { progress: 25 });

    // ── 2. AI extraction ───────────────────────────────────────────────────
    await updateJob(db, jobId, { status: "extracting", progress: 40 });

    const extracted = await extractWithClaude(pageTitle, metaDesc, bodyText);

    await updateJob(db, jobId, { progress: 60 });

    // ── 3. Download images → Storage ───────────────────────────────────────
    await updateJob(db, jobId, { status: "building", progress: 70 });

    // Hero: prefer og:image, else first img
    const heroSrc = ogImageUrl ?? imgUrls[0] ?? null;
    const heroUrl = heroSrc
      ? await downloadImageToStorage(db, heroSrc, salonId, "hero")
      : null;

    // Gallery: up to 5 additional images (skip the hero src)
    const gallerySrcs = imgUrls
      .filter((u) => u !== heroSrc)
      .slice(0, 5);
    const galleryUrls: string[] = [];
    for (let i = 0; i < gallerySrcs.length; i++) {
      const url = await downloadImageToStorage(db, gallerySrcs[i], salonId, `gallery-${i}`);
      if (url) galleryUrls.push(url);
    }

    // Logo: look for img with "logo" in src/alt
    const logoSrc = imgUrls.find((u) => /logo/i.test(u)) ?? null;
    const logoUrl = logoSrc
      ? await downloadImageToStorage(db, logoSrc, salonId, "logo")
      : null;

    await updateJob(db, jobId, { progress: 85 });

    // ── 4. Upsert salon data ───────────────────────────────────────────────
    await buildSalon(db, salonId, extracted, logoUrl, heroUrl, galleryUrls);

    await updateJob(db, jobId, { progress: 95 });

    // ── 5. Done ────────────────────────────────────────────────────────────
    const result = {
      salonName: extracted.name,
      servicesImported: (extracted.services ?? []).length,
      imagesDownloaded: galleryUrls.length + (heroUrl ? 1 : 0) + (logoUrl ? 1 : 0),
    };

    await updateJob(db, jobId, { status: "done", progress: 100, result });

    // Fire-and-forget email
    if (salonEmail) {
      sendCompletionEmail(
        salonEmail,
        salonSlug,
        extracted.name || salonSlug,
        (extracted.services ?? []).length,
      ).catch(() => {});
    }

    return jsonRes({ ok: true, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[scrape-website] error:", msg);
    await updateJob(db, jobId, { status: "failed", error_message: msg.slice(0, 500) });
    return jsonRes({ error: msg }, 500);
  }
});
