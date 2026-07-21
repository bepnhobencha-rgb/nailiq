import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { generateNailPreview, IMAGE_MODEL, TRYON_COOKIE } from "@/shared/nailTryOn/server";
import { verifySessionCredential } from "@/shared/nailTryOn/sessionCredential";
import { recordNailTryOnEvent } from "@/shared/nailTryOn/telemetry";
import { safeProviderError } from "@/shared/nailTryOn/providerError";
import { GENERATION_STALE_MS, isGenerationStale } from "@/shared/nailTryOn/generationLease";

export const runtime = "nodejs";
export const maxDuration = 300;

const bodySchema = z.object({ sessionId: z.string().uuid(), designId: z.string().uuid() });
type SessionRow = { id: string; salon_id: string; anonymous_token_hash: string; source_image_path: string; result_image_path: string | null; status: string; updated_at: string };
type DesignRow = { id: string; salon_id: string; name: string; preview_path: string; prompt_hint: string | null; version: number };

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const db = createServiceRoleClient();
  const { data: rawSession } = await db.from("nail_tryon_sessions" as never).select("id, salon_id, anonymous_token_hash, source_image_path, result_image_path, status, updated_at").eq("id", parsed.data.sessionId).maybeSingle();
  const session = rawSession as unknown as SessionRow | null;
  const cookie = (await cookies()).get(TRYON_COOKIE)?.value;
  if (!session || !verifySessionCredential(cookie, session.id, session.anonymous_token_hash)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (session.status === "ready" && session.result_image_path) {
    const { data: signed } = await db.storage.from("nail-tryon").createSignedUrl(session.result_image_path, 300);
    return NextResponse.json({ status: "ready", previewUrl: signed?.signedUrl });
  }
  let claimableStatus = session.status;
  if (session.status === "generating") {
    if (!isGenerationStale(session.updated_at)) {
      return NextResponse.json({ error: "generation_in_progress", retryable: true }, { status: 409, headers: { "Retry-After": "15" } });
    }
    const staleBefore = new Date(Date.now() - GENERATION_STALE_MS).toISOString();
    const { data: recovered } = await db.from("nail_tryon_sessions" as never)
      .update({ status: "quality_passed", error_code: "generation_timeout", updated_at: new Date().toISOString() } as never)
      .eq("id", session.id)
      .eq("status", "generating")
      .eq("updated_at", session.updated_at)
      .lt("updated_at", staleBefore)
      .select("id")
      .maybeSingle();
    if (recovered) claimableStatus = "quality_passed";
    else return NextResponse.json({ error: "generation_in_progress", retryable: true }, { status: 409, headers: { "Retry-After": "15" } });
  }
  if (claimableStatus !== "quality_passed" && claimableStatus !== "failed") {
    return NextResponse.json({ error: "invalid_state" }, { status: 409 });
  }

  const { data: rawDesign } = await db.from("nail_designs" as never).select("id, salon_id, name, preview_path, prompt_hint, version").eq("id", parsed.data.designId).eq("salon_id", session.salon_id).eq("is_active", true).is("deleted_at", null).maybeSingle();
  const design = rawDesign as unknown as DesignRow | null;
  if (!design) return NextResponse.json({ error: "design_not_found" }, { status: 404 });

  const { data: claimed } = await db.from("nail_tryon_sessions" as never).update({ status: "generating", design_id: design.id, design_version: design.version, provider: "openai", provider_model: IMAGE_MODEL, error_code: null, updated_at: new Date().toISOString() } as never).eq("id", session.id).in("status", ["quality_passed", "failed"]).select("id").maybeSingle();
  if (!claimed) return NextResponse.json({ error: "generation_in_progress" }, { status: 409 });
  await recordNailTryOnEvent({ salonId: session.salon_id, sessionId: session.id, event: "generation_started", properties: { designVersion: design.version } });
  const outputPath = `salon/${session.salon_id}/session/${session.id}/preview.jpg`;
  try {
    const [{ data: hand }, { data: reference }] = await Promise.all([
      db.storage.from("nail-tryon").download(session.source_image_path),
      db.storage.from("nail-tryon").download(design.preview_path),
    ]);
    if (!hand || !reference) throw new Error("input_download_failed");
    const preview = await generateNailPreview({ hand: Buffer.from(await hand.arrayBuffer()), design: Buffer.from(await reference.arrayBuffer()), designMime: reference.type, designName: design.name, promptHint: design.prompt_hint });
    const { error: uploadError } = await db.storage.from("nail-tryon").upload(outputPath, preview, { contentType: "image/jpeg", upsert: false });
    if (uploadError) throw uploadError;
    await db.from("nail_tryon_sessions" as never).update({ status: "ready", result_image_path: outputPath, updated_at: new Date().toISOString() } as never).eq("id", session.id);
    await recordNailTryOnEvent({ salonId: session.salon_id, sessionId: session.id, event: "generation_ready", properties: { designVersion: design.version } });
    const { data: signed } = await db.storage.from("nail-tryon").createSignedUrl(outputPath, 300);
    return NextResponse.json({ status: "ready", previewUrl: signed?.signedUrl });
  } catch (error) {
    const safeError = safeProviderError(error);
    console.error("[nail-tryon] generation failed", {
      sessionId: session.id,
      model: IMAGE_MODEL,
      ...safeError,
    });
    await db.storage.from("nail-tryon").remove([outputPath]).catch(() => undefined);
    await db.from("nail_tryon_sessions" as never).update({ status: "quality_passed", error_code: safeError.code, updated_at: new Date().toISOString() } as never).eq("id", session.id);
    await recordNailTryOnEvent({ salonId: session.salon_id, sessionId: session.id, event: "generation_failed", properties: { code: safeError.code, status: safeError.status, providerCode: safeError.providerCode, requestId: safeError.requestId } });
    return NextResponse.json({ error: safeError.code, retryable: true }, { status: 502 });
  }
}
