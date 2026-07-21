import { NextResponse } from "next/server";
import sharp from "sharp";
import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { loadPublicNailTryOnSalon } from "@/shared/nailTryOn/publicSalon";
import { z } from "zod";
import { mappingMatchesServices } from "@/shared/nailTryOn/designServiceMapping";

export const runtime = "nodejs";

const optionalServiceId = z.preprocess(
  (value) => value === "" || value == null ? null : value,
  z.string().uuid().nullable(),
);

async function authorizeSalon(slug: string) {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) } as const;
  const salon = await loadPublicNailTryOnSalon(slug);
  if (!salon) return { error: NextResponse.json({ error: "not_found" }, { status: 404 }) } as const;
  const db = createServiceRoleClient();
  const { data: membership } = await db.from("salon_members").select("role").eq("salon_id", salon.id).eq("user_id", user.id).maybeSingle();
  if (!membership || !["owner", "admin"].includes(membership.role)) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as const;
  return { user, salon, db } as const;
}

async function validateServiceMapping(db: ReturnType<typeof createServiceRoleClient>, salonId: string, serviceId: string | null, addonServiceId: string | null) {
  const ids = [serviceId, addonServiceId].filter((id): id is string => Boolean(id));
  if (!ids.length) return true;
  const { data } = await db.from("services" as never).select("id, is_addon").eq("salon_id", salonId).in("id", ids).is("deleted_at", null);
  const rows = (data || []) as unknown as Array<{ id: string; is_addon: boolean }>;
  return mappingMatchesServices(rows, serviceId, addonServiceId);
}

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const slug = String(form?.get("slug") || "");
  const name = String(form?.get("name") || "").trim();
  const description = String(form?.get("description") || "").trim();
  const image = form?.get("image") as File | null;
  const mapping = z.object({ serviceId: optionalServiceId, addonServiceId: optionalServiceId }).safeParse({ serviceId: form?.get("serviceId"), addonServiceId: form?.get("addonServiceId") });
  if (!name || name.length > 120 || !image || image.size > 10 * 1024 * 1024) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  if (!mapping.success) return NextResponse.json({ error: "invalid_service_mapping" }, { status: 400 });
  const authorized = await authorizeSalon(slug);
  if ("error" in authorized) return authorized.error;
  const { user, salon, db } = authorized;
  if (!await validateServiceMapping(db, salon.id, mapping.data.serviceId, mapping.data.addonServiceId)) return NextResponse.json({ error: "invalid_service_mapping" }, { status: 400 });
  let normalized: Buffer;
  try {
    normalized = await sharp(Buffer.from(await image.arrayBuffer()), { limitInputPixels: 20_000_000 }).rotate().resize({ width: 1400, height: 1400, fit: "cover" }).jpeg({ quality: 90 }).toBuffer();
  } catch { return NextResponse.json({ error: "invalid_image" }, { status: 422 }); }
  const id = crypto.randomUUID();
  const path = `salon/${salon.id}/design/${id}.jpg`;
  const { error: uploadError } = await db.storage.from("nail-tryon").upload(path, normalized, { contentType: "image/jpeg", upsert: false });
  if (uploadError) return NextResponse.json({ error: "upload_failed" }, { status: 500 });
  const { error: insertError } = await db.from("nail_designs" as never).insert({ id, salon_id: salon.id, name, description: description || null, preview_path: path, created_by: user.id, service_id: mapping.data.serviceId, addon_service_id: mapping.data.addonServiceId } as never);
  if (insertError) { await db.storage.from("nail-tryon").remove([path]); return NextResponse.json({ error: "insert_failed" }, { status: 500 }); }
  const { data: signed } = await db.storage.from("nail-tryon").createSignedUrl(path, 300);
  return NextResponse.json({ design: { id, name, description: description || null, active: true, previewUrl: signed?.signedUrl || null, serviceId: mapping.data.serviceId, addonServiceId: mapping.data.addonServiceId } }, { status: 201 });
}

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = z.object({ slug: z.string().min(1), designId: z.string().uuid(), serviceId: optionalServiceId, addonServiceId: optionalServiceId }).safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const authorized = await authorizeSalon(parsed.data.slug);
  if ("error" in authorized) return authorized.error;
  const { salon, db } = authorized;
  if (!await validateServiceMapping(db, salon.id, parsed.data.serviceId, parsed.data.addonServiceId)) return NextResponse.json({ error: "invalid_service_mapping" }, { status: 400 });
  const { data, error } = await db.from("nail_designs" as never)
    .update({ service_id: parsed.data.serviceId, addon_service_id: parsed.data.addonServiceId, updated_at: new Date().toISOString() } as never)
    .eq("id", parsed.data.designId).eq("salon_id", salon.id).is("deleted_at", null)
    .select("id").maybeSingle();
  if (error) return NextResponse.json({ error: "update_failed" }, { status: 500 });
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
