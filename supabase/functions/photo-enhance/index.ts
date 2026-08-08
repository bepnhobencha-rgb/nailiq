// Supabase Edge Function — photo-enhance
// Called by webhook on booking_photos insert OR directly after photo-upload.
// Uses Claude Haiku vision to analyze the nail photo and populate ai_* fields.

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  type EdgeUsageLedgerClient,
  trackAnthropicEdgeFetch,
} from "../_shared/aiUsageLedger.ts";
import { rejectUnauthorizedInternalRequest } from "../_shared/internalAuth.ts";
import { supabaseSecretKey } from "../_shared/supabaseApiKeys.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = supabaseSecretKey();
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type AiAnalysisResult = {
  detected_services: string[];
  detected_colors: string[];
  detected_style: string;
  quality_score: number;
  is_appropriate: boolean;
};

async function analyzeWithClaude(
  db: EdgeUsageLedgerClient,
  salonId: string,
  imageBase64: string,
  mimeType: string,
): Promise<AiAnalysisResult> {
  const response = await trackAnthropicEdgeFetch(
    db,
    {
      salonId,
      feature: "photo_enhance",
      model: ANTHROPIC_MODEL,
    },
    () => fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 512,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mimeType,
                  data: imageBase64,
                },
              },
              {
                type: "text",
                text: `Analyze this nail photo. Return only valid JSON with this exact shape:
{
  "detected_services": ["list of nail services visible, e.g. gel manicure, acrylic fill, nail art"],
  "detected_colors": ["list of color names visible on nails"],
  "detected_style": "brief style description (e.g. French tip, ombre, solid, nail art)",
  "quality_score": 0.0,
  "is_appropriate": true
}
Rules:
- quality_score is 0.0–1.0: 1.0 = sharp, well-lit, clearly shows nails; 0.0 = blurry, dark, not a nail photo
- is_appropriate = false only if the photo contains explicit/inappropriate content
- All arrays may be empty if nothing detected
Return ONLY the JSON object, no explanation.`,
              },
            ],
          },
        ],
      }),
    }),
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>;
  };

  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text block in Claude response");

  // Extract JSON from response (Claude may wrap it in markdown)
  const rawText = textBlock.text.trim();
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON found in Claude response");

  const parsed = JSON.parse(jsonMatch[0]) as AiAnalysisResult;
  return parsed;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonError("Method not allowed", 405);
  }

  const unauthorized = await rejectUnauthorizedInternalRequest(req, corsHeaders);
  if (unauthorized) return unauthorized;

  let body: { photo_id?: string };
  try {
    body = await req.json() as { photo_id?: string };
  } catch {
    return jsonError("Invalid JSON body");
  }

  const photoId = body.photo_id?.trim();
  if (!photoId) return jsonError("Missing photo_id");

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Fetch the booking_photos row
  const { data: photoRow, error: photoErr } = await db
    .from("booking_photos")
    .select("id, storage_path, salon_id, booking_id")
    .eq("id", photoId)
    .is("deleted_at", null)
    .maybeSingle();

  if (photoErr || !photoRow) {
    return jsonError("Photo not found", 404);
  }

  // Download photo from storage as signed URL then fetch bytes
  const { data: signedUrlData, error: signedErr } = await db.storage
    .from("booking-photos")
    .createSignedUrl(photoRow.storage_path, 60); // 60-second expiry

  if (signedErr || !signedUrlData?.signedUrl) {
    console.error("[photo-enhance] Signed URL error:", signedErr);
    return jsonError("Failed to access photo storage", 500);
  }

  const imageResponse = await fetch(signedUrlData.signedUrl);
  if (!imageResponse.ok) {
    return jsonError("Failed to download photo", 500);
  }

  const imageBytes = await imageResponse.arrayBuffer();
  const contentType = imageResponse.headers.get("content-type") ?? "image/jpeg";
  // Convert to base64
  const uint8Array = new Uint8Array(imageBytes);
  let binaryString = "";
  for (let i = 0; i < uint8Array.length; i++) {
    binaryString += String.fromCharCode(uint8Array[i]);
  }
  const imageBase64 = btoa(binaryString);

  // Validate mime type for Anthropic
  const supportedMimes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  const mimeType = supportedMimes.includes(contentType) ? contentType : "image/jpeg";

  // Analyze with Claude
  let analysis: AiAnalysisResult;
  try {
    analysis = await analyzeWithClaude(
      db as unknown as EdgeUsageLedgerClient,
      photoRow.salon_id,
      imageBase64,
      mimeType,
    );
  } catch (err) {
    console.error("[photo-enhance] Claude analysis error:", err);
    // Update with a failed/low-quality marker rather than crashing
    await db
      .from("booking_photos")
      .update({
        ai_processed_at: new Date().toISOString(),
        ai_quality_score: 0,
        ai_tags: { error: "analysis_failed" },
      })
      .eq("id", photoId);
    return jsonError("AI analysis failed", 500);
  }

  const aiTags: Record<string, unknown> = {};
  if (analysis.quality_score < 0.5) {
    aiTags.needs_retake = true;
  }
  if (!analysis.is_appropriate) {
    aiTags.inappropriate = true;
  }

  // Update booking_photos with AI results
  const { error: updateError } = await db
    .from("booking_photos")
    .update({
      ai_detected_services: analysis.detected_services,
      ai_detected_colors: analysis.detected_colors,
      ai_detected_style: analysis.detected_style,
      ai_quality_score: analysis.quality_score,
      ai_processed_at: new Date().toISOString(),
      ai_tags: Object.keys(aiTags).length > 0 ? aiTags : null,
    })
    .eq("id", photoId);

  if (updateError) {
    console.error("[photo-enhance] DB update error:", updateError);
    return jsonError("Failed to save AI results", 500);
  }

  return new Response(
    JSON.stringify({
      photo_id: photoId,
      quality_score: analysis.quality_score,
      needs_retake: aiTags.needs_retake ?? false,
      is_appropriate: analysis.is_appropriate,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
