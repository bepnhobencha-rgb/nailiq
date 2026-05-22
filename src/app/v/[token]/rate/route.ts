// Rating API route — POST /v/[token]/rate
// Validates JWT token, updates booking_photos with customer rating.
// Rating 4-5 → returns Google review redirect (if available).
// Rating 1-3 → saves internally, no redirect.

import { NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

type JwtPayload = {
  photo_id: string;
  iat?: number;
  exp?: number;
};

async function decodePhotoToken(token: string): Promise<string | null> {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  try {
    const secretBytes = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, secretBytes);
    const photoId = (payload as unknown as JwtPayload).photo_id;
    return typeof photoId === "string" ? photoId : null;
  } catch {
    return null;
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  // Decode and verify JWT
  const photoId = await decodePhotoToken(token);
  if (!photoId) {
    return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
  }

  // Parse body
  let body: { rating?: unknown; feedback?: string };
  try {
    body = (await req.json()) as { rating?: unknown; feedback?: string };
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return NextResponse.json({ error: "Rating must be an integer 1–5" }, { status: 400 });
  }

  const feedback = typeof body.feedback === "string" ? body.feedback.trim().slice(0, 1000) : null;

  const db = createServiceRoleClient();

  // Fetch photo row to get salon_id and check it exists
  const { data: photoRow, error: photoErr } = await db
    .from("booking_photos")
    .select("id, salon_id, customer_rating")
    .eq("id", photoId)
    .is("deleted_at", null)
    .maybeSingle();

  if (photoErr || !photoRow) {
    return NextResponse.json({ error: "Photo not found" }, { status: 404 });
  }

  // Update rating
  const { error: updateError } = await db
    .from("booking_photos")
    .update({
      customer_rating: rating,
      customer_rated_at: new Date().toISOString(),
      ...(feedback ? { customer_feedback: feedback } : {}),
    })
    .eq("id", photoId);

  if (updateError) {
    console.error("[rate] Update error:", updateError);
    return NextResponse.json({ error: "Failed to save rating" }, { status: 500 });
  }

  // For high ratings (4-5), try to get Google review URL from salon
  // Note: salons table may not have google_review_url — safely skip
  if (rating >= 4) {
    try {
      const { data: salon } = await db
        .from("salons")
        .select("*")
        .eq("id", photoRow.salon_id)
        .maybeSingle();

      // Attempt to access google_review_url if it exists on the record
      const salonRecord = salon as Record<string, unknown> | null;
      const googleUrl =
        typeof salonRecord?.google_review_url === "string" &&
        salonRecord.google_review_url.trim().length > 0
          ? salonRecord.google_review_url.trim()
          : null;

      if (googleUrl) {
        return NextResponse.json({ redirect: googleUrl, internal: false });
      }
    } catch {
      // Silently skip — google_review_url column may not exist
    }
  }

  // Low rating or no Google URL: save internally
  return NextResponse.json({ redirect: null, internal: true });
}
