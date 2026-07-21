import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { generateNailPreview, IMAGE_MODEL, TRYON_COOKIE } from "@/shared/nailTryOn/server";
import { verifySessionCredential } from "@/shared/nailTryOn/sessionCredential";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({ sessionId: z.string().uuid(), designId: z.string().uuid() });
type SessionRow = { id: string; salon_id: string; anonymous_token_hash: string; source_image_path: string; result_image_path: string | null; status: string };
type DesignRow = { id: string; salon_id: string; name: string; preview_path: string; prompt_hint: string | null; version: number };

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const db = createServiceRoleClient();
  const { data: rawSession } = await db.from("nail_tryon_sessions" as never).select("id, salon_id, anonymous_token_hash, source_image_path, result_image_path, status").eq("id", parsed.data.sessionId).maybeSingle();
  const session = rawSession as unknown as SessionRow | null;
  const cookie = (await cookies()).get(TRYON_COOKIE)?.value;
  if (!session || !verifySessionCredential(cookie, session.id, session.anonymous_token_hash)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (session.status === "ready" && session.result_image_path) {
    const { data: signed } = await db.storage.from("nail-tryon").createSignedUrl(session.result_image_path, 300);
    return NextResponse.json({ status: "ready", previewUrl: signed?.signedUrl });
  }
  if (session.status !== "quality_passed") return NextResponse.json({ error: "invalid_state" }, { status: 409 });

  const { data: rawDesign } = await db.from("nail_designs" as never).select("id, salon_id, name, preview_path, prompt_hint, version").eq("id", parsed.data.designId).eq("salon_id", session.salon_id).eq("is_active", true).is("deleted_at", null).maybeSingle();
  const design = rawDesign as unknown as DesignRow | null;
  if (!design) return NextResponse.json({ error: "design_not_found" }, { status: 404 });

  const { data: claimed } = await db.from("nail_tryon_sessions" as never).update({ status: "generating", design_id: design.id, design_version: design.version, provider: "openai", provider_model: IMAGE_MODEL, updated_at: new Date().toISOString() } as never).eq("id", session.id).eq("status", "quality_passed").select("id").maybeSingle();
  if (!claimed) return NextResponse.json({ error: "generation_in_progress" }, { status: 409 });
  try {
    const [{ data: hand }, { data: reference }] = await Promise.all([
      db.storage.from("nail-tryon").download(session.source_image_path),
      db.storage.from("nail-tryon").download(design.preview_path),
    ]);
    if (!hand || !reference) throw new Error("input_download_failed");
    const preview = await generateNailPreview({ hand: Buffer.from(await hand.arrayBuffer()), design: Buffer.from(await reference.arrayBuffer()), designMime: reference.type, designName: design.name, promptHint: design.prompt_hint });
    const outputPath = `salon/${session.salon_id}/session/${session.id}/preview.jpg`;
    const { error: uploadError } = await db.storage.from("nail-tryon").upload(outputPath, preview, { contentType: "image/jpeg", upsert: false });
    if (uploadError) throw uploadError;
    await db.from("nail_tryon_sessions" as never).update({ status: "ready", result_image_path: outputPath, updated_at: new Date().toISOString() } as never).eq("id", session.id);
    const { data: signed } = await db.storage.from("nail-tryon").createSignedUrl(outputPath, 300);
    return NextResponse.json({ status: "ready", previewUrl: signed?.signedUrl });
  } catch {
    await db.from("nail_tryon_sessions" as never).update({ status: "failed", error_code: "generation_failed", updated_at: new Date().toISOString() } as never).eq("id", session.id);
    return NextResponse.json({ error: "generation_failed" }, { status: 502 });
  }
}
