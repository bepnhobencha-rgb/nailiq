import { NextResponse } from "next/server";
import sharp from "sharp";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { loadPublicNailTryOnSalon } from "@/shared/nailTryOn/publicSalon";
import { inspectHandPhoto, TRYON_COOKIE } from "@/shared/nailTryOn/server";
import { createSessionCredential } from "@/shared/nailTryOn/sessionCredential";
import { recordNailTryOnEvent } from "@/shared/nailTryOn/telemetry";
import { decideServerQuality } from "@/shared/nailTryOn/qualityPolicy";
import { parseNailTryOnCaptureMode } from "@/shared/nailTryOn/captureMode";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const photo = form?.get("photo") as File | null;
  const slug = String(form?.get("slug") || "");
  const consentVersion = String(form?.get("consent_version") || "");
  const captureMode = parseNailTryOnCaptureMode(form?.get("capture_mode"));
  if (!photo || !slug || consentVersion !== "nail-tryon-v1") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (!TYPES.has(photo.type)) return NextResponse.json({ error: "unsupported_format" }, { status: 415 });
  if (photo.size > MAX_BYTES) return NextResponse.json({ error: "file_too_large" }, { status: 413 });

  const salon = await loadPublicNailTryOnSalon(slug);
  if (!salon) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const db = createServiceRoleClient();
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await db.from("nail_tryon_sessions" as never)
    .select("id", { count: "exact", head: true }).eq("salon_id", salon.id).gte("created_at", since);
  if ((count ?? 0) >= 20) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  let normalized: Buffer;
  try {
    const input = Buffer.from(await photo.arrayBuffer());
    const metadata = await sharp(input, { limitInputPixels: 20_000_000 }).metadata();
    if (!metadata.width || !metadata.height || metadata.width < 720 || metadata.height < 720) {
      return NextResponse.json({ error: "resolution_too_low" }, { status: 422 });
    }
    normalized = await sharp(input, { limitInputPixels: 20_000_000 })
      .rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  } catch {
    return NextResponse.json({ error: "invalid_image" }, { status: 422 });
  }

  const sessionId = crypto.randomUUID();
  const credential = createSessionCredential(sessionId);
  const path = `salon/${salon.id}/session/${sessionId}/original.jpg`;
  const { error: uploadError } = await db.storage.from("nail-tryon").upload(path, normalized, {
    contentType: "image/jpeg", upsert: false,
  });
  if (uploadError) return NextResponse.json({ error: "upload_failed" }, { status: 500 });

  const { error: insertError } = await db.from("nail_tryon_sessions" as never).insert({
    id: sessionId,
    salon_id: salon.id,
    anonymous_token_hash: credential.tokenHash,
    source_image_path: path,
    status: "uploaded",
    consent_at: new Date().toISOString(),
    consent_version: consentVersion,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  } as never);
  if (insertError) {
    await db.storage.from("nail-tryon").remove([path]);
    return NextResponse.json({ error: "session_failed" }, { status: 500 });
  }
  await recordNailTryOnEvent({ salonId: salon.id, sessionId, event: "upload_received", properties: { bytes: normalized.byteLength } });

  try {
    const verdict = await inspectHandPhoto(normalized, captureMode);
    const decision = decideServerQuality(verdict);
    const passed = decision.passed;
    const qualityCode = decision.code;
    await db.from("nail_tryon_sessions" as never).update({
      status: passed ? "quality_passed" : "quality_rejected",
      quality_code: qualityCode,
      provider: "openai",
      provider_model: process.env.NAIL_TRYON_QUALITY_MODEL || "gpt-5.6-luna",
      updated_at: new Date().toISOString(),
    } as never).eq("id", sessionId);

    const response = NextResponse.json({
      sessionId,
      quality: passed ? "pass" : qualityCode,
      warning: decision.warning,
      reason: verdict.reason,
    }, { status: passed ? 201 : 422 });
    await recordNailTryOnEvent({ salonId: salon.id, sessionId, event: passed ? "quality_passed" : "quality_rejected", properties: { code: passed ? (decision.warning ? qualityCode : "pass") : qualityCode, warning: decision.warning, visibleNails: verdict.visibleNails, captureMode } });
    response.cookies.set(TRYON_COOKIE, credential.cookieValue, {
      httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 24 * 60 * 60,
    });
    return response;
  } catch {
    return NextResponse.json({ error: "quality_unavailable", sessionId }, { status: 503 });
  }
}
