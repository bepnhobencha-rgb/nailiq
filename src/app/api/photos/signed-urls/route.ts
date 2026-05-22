import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export const dynamic = "force-dynamic";

/**
 * GET /api/photos/signed-urls?ids=uuid1,uuid2,...
 * Returns map of photo_id → signed URL (60 min expiry).
 * Used by TrendingSection to display trend photos.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const idsParam = searchParams.get("ids");
  if (!idsParam) return NextResponse.json({});

  const ids = idsParam.split(",").filter(Boolean).slice(0, 20); // max 20

  const db = createServiceRoleClient();

  // Fetch storage paths for these photo IDs
  const { data: photos } = await db
    .from("booking_photos")
    .select("id, storage_path")
    .in("id", ids)
    .is("deleted_at", null);

  if (!photos?.length) return NextResponse.json({});

  // Generate signed URLs
  const result: Record<string, string> = {};
  await Promise.all(
    photos.map(async (p) => {
      const { data } = await db.storage
        .from("booking-photos")
        .createSignedUrl(p.storage_path, 3600);
      if (data?.signedUrl) result[p.id] = data.signedUrl;
    })
  );

  return NextResponse.json(result);
}
