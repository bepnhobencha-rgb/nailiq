import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { loadPublicNailTryOnSalon } from "@/shared/nailTryOn/publicSalon";
import { recordNailTryOnEvent } from "@/shared/nailTryOn/telemetry";
import { consumePublicRequestRateLimit } from "@/shared/security/publicServerActionRateLimit";

type DesignRow = { id: string; name: string; description: string | null; preview_path: string; version: number; palette: unknown; style_tags: string[] };

export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("slug") || "";
  const rate = await consumePublicRequestRateLimit({
    request,
    scope: "nail-tryon-catalog",
    identity: [slug],
    ipLimits: [[30, 60], [300, 3_600]],
    identityLimits: [[120, 60], [1_000, 3_600]],
  });
  if (rate !== "allowed") {
    return NextResponse.json(
      { error: rate === "limited" ? "rate_limited" : "temporarily_unavailable" },
      { status: rate === "limited" ? 429 : 503 },
    );
  }
  const salon = await loadPublicNailTryOnSalon(slug);
  if (!salon) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const db = createServiceRoleClient();
  const { data, error } = await db.from("nail_designs" as never)
    .select("id, name, description, preview_path, version, palette, style_tags")
    .eq("salon_id", salon.id).eq("is_active", true).is("deleted_at", null).order("sort_order");
  if (error) return NextResponse.json({ error: "catalog_unavailable" }, { status: 500 });
  const designs = await Promise.all(((data || []) as unknown as DesignRow[]).map(async (design) => {
    const { data: signed } = await db.storage.from("nail-tryon").createSignedUrl(design.preview_path, 300);
    return { id: design.id, name: design.name, description: design.description, version: design.version, palette: design.palette, styleTags: design.style_tags, previewUrl: signed?.signedUrl || null };
  }));
  await recordNailTryOnEvent({ salonId: salon.id, event: "catalog_viewed", properties: { designCount: designs.length } });
  return NextResponse.json({ designs }, { headers: { "Cache-Control": "private, max-age=60" } });
}
