import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { consumePublicRequestRateLimit } from "@/shared/security/publicServerActionRateLimit";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
} as const;

type PhotoBinding = {
  id: string;
  storage_path: string;
  salon_id: string;
  bookings:
    | { client_phone: string | null; salon_id: string }
    | { client_phone: string | null; salon_id: string }[]
    | null;
};

type TrendCacheRow = {
  salon_id: string;
  trends: unknown;
};

function reply(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

function bookingFor(photo: PhotoBinding) {
  return Array.isArray(photo.bookings) ? photo.bookings[0] ?? null : photo.bookings;
}

/**
 * GET /api/photos/signed-urls?ids=uuid1,uuid2,...
 * Returns map of photo_id → signed URL (5 min expiry).
 * Used by TrendingSection to display trend photos.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const idsParam = searchParams.get("ids");
  if (!idsParam) return reply({});

  if (idsParam.length > 800) return reply({ error: "invalid_photo_ids" }, 400);
  const ids = [...new Set(idsParam.split(",").map((id) => id.trim()).filter(Boolean))].sort();
  if (ids.length === 0 || ids.length > 20 || ids.some((id) => !UUID_RE.test(id))) {
    return reply({ error: "invalid_photo_ids" }, 400);
  }

  const rate = await consumePublicRequestRateLimit({
    request: req,
    scope: "public-photo-signed-urls",
    identity: ids,
    ipLimits: [[30, 60], [300, 3_600]],
    identityLimits: [[60, 60], [500, 3_600]],
  });
  if (rate !== "allowed") {
    return reply(
      { error: rate === "limited" ? "rate_limited" : "temporarily_unavailable" },
      rate === "limited" ? 429 : 503,
    );
  }

  const db = createServiceRoleClient();

  // Service-role access is restricted by an authoritative photo -> booking
  // binding and the customer's current public-sharing consent. Knowing a
  // photo UUID alone must never be enough to mint a storage URL.
  const { data: rawPhotos, error: photosError } = await db
    .from("booking_photos")
    .select("id, storage_path, salon_id, bookings!inner(client_phone, salon_id)")
    .in("id", ids)
    .is("deleted_at", null);

  if (photosError) return reply({ error: "temporarily_unavailable" }, 503);

  const photos = ((rawPhotos ?? []) as PhotoBinding[]).filter((photo) => {
    const booking = bookingFor(photo);
    return Boolean(
      photo.id &&
      photo.storage_path &&
      photo.salon_id &&
      booking?.client_phone &&
      booking.salon_id === photo.salon_id,
    );
  });

  if (photos.length === 0) return reply({});

  const salonIds = [...new Set(photos.map((photo) => photo.salon_id))];
  const { data: rawTrendRows, error: trendsError } = await db
    .from("ai_trend_cache")
    .select("salon_id, trends")
    .in("salon_id", salonIds)
    .eq("period", "this_week");

  if (trendsError) return reply({ error: "temporarily_unavailable" }, 503);

  const trendPhotoKeys = new Set<string>();
  for (const row of (rawTrendRows ?? []) as TrendCacheRow[]) {
    if (!row.salon_id || !Array.isArray(row.trends)) continue;
    for (const trend of row.trends) {
      if (
        trend &&
        typeof trend === "object" &&
        "photo_id" in trend &&
        typeof trend.photo_id === "string" &&
        UUID_RE.test(trend.photo_id)
      ) {
        trendPhotoKeys.add(`${row.salon_id}\u0000${trend.photo_id}`);
      }
    }
  }
  const trendingPhotos = photos.filter((photo) =>
    trendPhotoKeys.has(`${photo.salon_id}\u0000${photo.id}`),
  );

  if (trendingPhotos.length === 0) return reply({});

  const phones = [
    ...new Set(
      trendingPhotos
        .map((photo) => bookingFor(photo)?.client_phone)
        .filter((phone): phone is string => Boolean(phone)),
    ),
  ];
  const { data: consents, error: consentsError } = await db
    .from("customer_photo_consents")
    .select("salon_id, client_phone")
    .in("salon_id", salonIds)
    .in("client_phone", phones)
    .eq("consent_share_public", true)
    .is("revoked_at", null);

  if (consentsError) return reply({ error: "temporarily_unavailable" }, 503);

  const allowed = new Set(
    (consents ?? []).map((consent) => `${consent.salon_id}\u0000${consent.client_phone}`),
  );
  const publicPhotos = trendingPhotos.filter((photo) => {
    const phone = bookingFor(photo)?.client_phone;
    return phone ? allowed.has(`${photo.salon_id}\u0000${phone}`) : false;
  });

  if (publicPhotos.length === 0) return reply({});

  // Generate signed URLs
  const result: Record<string, string> = {};
  await Promise.all(
    publicPhotos.map(async (photo) => {
      try {
        const { data, error } = await db.storage
          .from("booking-photos")
          .createSignedUrl(photo.storage_path, 300);
        if (!error && data?.signedUrl) result[photo.id] = data.signedUrl;
      } catch {
        // A storage timeout must not bypass the consent boundary or leak
        // provider details. Other eligible photos may still be returned.
      }
    })
  );

  return reply(result);
}
