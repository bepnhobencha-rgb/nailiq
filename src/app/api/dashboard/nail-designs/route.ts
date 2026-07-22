import { NextResponse } from "next/server";
import sharp from "sharp";
import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { loadPublicNailTryOnSalon } from "@/shared/nailTryOn/publicSalon";
import { z } from "zod";
import { mappingMatchesServices } from "@/shared/nailTryOn/designServiceMapping";
import { autoMapNailDesign } from "@/shared/nailTryOn/server";
import type { AutoMappingResult, AutoMappingService } from "@/shared/nailTryOn/autoMapping";

export const runtime = "nodejs";
export const maxDuration = 60;

const optionalServiceId = z.preprocess(
  (value) => value === "" || value == null ? null : value,
  z.string().uuid().nullable(),
);
const serviceIdsSchema = z.array(z.string().uuid()).max(50);

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

async function validateServiceMapping(db: ReturnType<typeof createServiceRoleClient>, salonId: string, mapping: { serviceIds: string[]; addonServiceIds: string[]; defaultServiceId: string | null }) {
  const ids = [...mapping.serviceIds, ...mapping.addonServiceIds];
  if (!ids.length) return true;
  const { data } = await db.from("services" as never).select("id, is_addon").eq("salon_id", salonId).in("id", ids).is("deleted_at", null);
  const rows = (data || []) as unknown as Array<{ id: string; is_addon: boolean }>;
  return mappingMatchesServices(rows, mapping);
}

async function replaceServiceMappings(db: ReturnType<typeof createServiceRoleClient>, designId: string, salonId: string, mapping: { serviceIds: string[]; addonServiceIds: string[]; defaultServiceId: string | null }) {
  const { error } = await db.rpc("replace_nail_design_service_mappings" as never, {
    p_design_id: designId,
    p_salon_id: salonId,
    p_service_ids: mapping.serviceIds,
    p_addon_service_ids: mapping.addonServiceIds,
    p_default_service_id: mapping.defaultServiceId,
  } as never);
  return !error;
}

async function loadServiceMenu(db: ReturnType<typeof createServiceRoleClient>, salonId: string) {
  const { data } = await db.from("services" as never)
    .select("id, name, description, category, is_addon, price_cents, duration_minutes")
    .eq("salon_id", salonId).is("deleted_at", null).order("name");
  return ((data || []) as unknown as Array<{ id: string; name: string; description: string | null; category: string | null; is_addon: boolean; price_cents: number | null; duration_minutes: number | null }>).map((row): AutoMappingService => ({
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    isAddon: row.is_addon,
    priceCents: row.price_cents,
    durationMinutes: row.duration_minutes,
  }));
}

async function saveMappingMetadata(db: ReturnType<typeof createServiceRoleClient>, designId: string, salonId: string, mapping: AutoMappingResult) {
  const { error } = await db.from("nail_designs" as never).update({
    mapping_status: mapping.status,
    mapping_visual_confidence: mapping.visualConfidence,
    mapping_service_confidence: mapping.serviceConfidence,
    mapping_reason: mapping.reason,
    mapping_attributes: mapping.attributes,
    mapping_required_question: mapping.requiredQuestion,
  } as never).eq("id", designId).eq("salon_id", salonId);
  return !error;
}

async function analyzeAndSave(args: {
  db: ReturnType<typeof createServiceRoleClient>;
  salonId: string;
  design: { id: string; name: string; description: string | null; preview_path: string };
  services: readonly AutoMappingService[];
  image?: Buffer;
}): Promise<AutoMappingResult & { designId: string }> {
  let image = args.image;
  if (!image) {
    const { data, error } = await args.db.storage.from("nail-tryon").download(args.design.preview_path);
    if (error || !data) throw new Error("design_image_unavailable");
    image = Buffer.from(await data.arrayBuffer());
  }
  const mapping = await autoMapNailDesign({
    image,
    designName: args.design.name,
    description: args.design.description,
    services: args.services,
  });
  if (!await replaceServiceMappings(args.db, args.design.id, args.salonId, mapping)) throw new Error("mapping_failed");
  if (!await saveMappingMetadata(args.db, args.design.id, args.salonId, mapping)) throw new Error("mapping_metadata_failed");
  return { designId: args.design.id, ...mapping };
}

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const slug = String(form?.get("slug") || "");
  const name = String(form?.get("name") || "").trim();
  const description = String(form?.get("description") || "").trim();
  const image = form?.get("image") as File | null;
  if (!name || name.length > 120 || !image || image.size > 10 * 1024 * 1024) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const authorized = await authorizeSalon(slug);
  if ("error" in authorized) return authorized.error;
  const { user, salon, db } = authorized;
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
  let mapping: AutoMappingResult;
  try {
    const services = await loadServiceMenu(db, salon.id);
    mapping = await analyzeAndSave({
      db, salonId: salon.id, services, image: normalized,
      design: { id, name, description: description || null, preview_path: path },
    });
  } catch {
    await Promise.all([
      db.from("nail_designs" as never).delete().eq("id", id).eq("salon_id", salon.id),
      db.storage.from("nail-tryon").remove([path]),
    ]);
    return NextResponse.json({ error: "mapping_failed" }, { status: 500 });
  }
  const { data: signed } = await db.storage.from("nail-tryon").createSignedUrl(path, 300);
  return NextResponse.json({ design: { id, name, description: description || null, active: true, previewUrl: signed?.signedUrl || null, ...mapping } }, { status: 201 });
}

export async function PUT(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = z.object({ slug: z.string().min(1), designIds: z.array(z.string().uuid()).min(1).max(6) }).safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const authorized = await authorizeSalon(parsed.data.slug);
  if ("error" in authorized) return authorized.error;
  const { salon, db } = authorized;
  const { data } = await db.from("nail_designs" as never)
    .select("id, name, description, preview_path")
    .eq("salon_id", salon.id).in("id", parsed.data.designIds).is("deleted_at", null);
  const designs = (data || []) as unknown as Array<{ id: string; name: string; description: string | null; preview_path: string }>;
  if (designs.length !== new Set(parsed.data.designIds).size) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const services = await loadServiceMenu(db, salon.id);
  const results: Array<(AutoMappingResult & { designId: string }) | { designId: string; error: string }> = [];
  for (let index = 0; index < designs.length; index += 3) {
    const chunk = designs.slice(index, index + 3);
    results.push(...await Promise.all(chunk.map(async (design) => {
      try {
        return await analyzeAndSave({ db, salonId: salon.id, design, services });
      } catch {
        return { designId: design.id, error: "mapping_failed" };
      }
    })));
  }
  return NextResponse.json({ results });
}

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = z.object({ slug: z.string().min(1), designId: z.string().uuid(), serviceIds: serviceIdsSchema, addonServiceIds: serviceIdsSchema, defaultServiceId: optionalServiceId }).safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const authorized = await authorizeSalon(parsed.data.slug);
  if ("error" in authorized) return authorized.error;
  const { salon, db } = authorized;
  const mapping = { serviceIds: parsed.data.serviceIds, addonServiceIds: parsed.data.addonServiceIds, defaultServiceId: parsed.data.defaultServiceId };
  if (!await validateServiceMapping(db, salon.id, mapping)) return NextResponse.json({ error: "invalid_service_mapping" }, { status: 400 });
  const { data: design } = await db.from("nail_designs" as never).select("id").eq("id", parsed.data.designId).eq("salon_id", salon.id).is("deleted_at", null).maybeSingle();
  if (!design) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!await replaceServiceMappings(db, parsed.data.designId, salon.id, mapping)) return NextResponse.json({ error: "update_failed" }, { status: 500 });
  const { error: statusError } = await db.from("nail_designs" as never)
    .update({ mapping_status: "ready", mapping_required_question: null } as never)
    .eq("id", parsed.data.designId).eq("salon_id", salon.id);
  if (statusError) return NextResponse.json({ error: "update_failed" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
