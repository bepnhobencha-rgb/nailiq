import { NextResponse } from "next/server";
import sharp from "sharp";
import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { loadPublicNailTryOnSalon } from "@/shared/nailTryOn/publicSalon";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const form = await request.formData().catch(() => null);
  const slug = String(form?.get("slug") || "");
  const name = String(form?.get("name") || "").trim();
  const description = String(form?.get("description") || "").trim();
  const image = form?.get("image") as File | null;
  if (!name || name.length > 120 || !image || image.size > 10 * 1024 * 1024) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const salon = await loadPublicNailTryOnSalon(slug);
  if (!salon) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const db = createServiceRoleClient();
  const { data: membership } = await db.from("salon_members").select("role").eq("salon_id", salon.id).eq("user_id", user.id).maybeSingle();
  if (!membership || !["owner", "admin"].includes(membership.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let normalized: Buffer;
  try {
    normalized = await sharp(Buffer.from(await image.arrayBuffer()), { limitInputPixels: 20_000_000 }).rotate().resize({ width: 1400, height: 1400, fit: "cover" }).jpeg({ quality: 90 }).toBuffer();
  } catch { return NextResponse.json({ error: "invalid_image" }, { status: 422 }); }
  const id = crypto.randomUUID();
  const path = `salon/${salon.id}/design/${id}.jpg`;
  const { error: uploadError } = await db.storage.from("nail-tryon").upload(path, normalized, { contentType: "image/jpeg", upsert: false });
  if (uploadError) return NextResponse.json({ error: "upload_failed" }, { status: 500 });
  const { error: insertError } = await db.from("nail_designs" as never).insert({ id, salon_id: salon.id, name, description: description || null, preview_path: path, created_by: user.id } as never);
  if (insertError) { await db.storage.from("nail-tryon").remove([path]); return NextResponse.json({ error: "insert_failed" }, { status: 500 }); }
  const { data: signed } = await db.storage.from("nail-tryon").createSignedUrl(path, 300);
  return NextResponse.json({ design: { id, name, description: description || null, active: true, previewUrl: signed?.signedUrl || null } }, { status: 201 });
}
