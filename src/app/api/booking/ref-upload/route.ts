// POST /api/booking/ref-upload
// Accepts multipart: { file: File, salon_id: string }
// Uploads client's inspiration image to 'booking-refs' bucket.
// Returns { ref_path } — caller stores it and passes to set-ref-image after booking.

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "invalid_form" }, { status: 400 });

  const file = form.get("file") as File | null;
  const salonId = form.get("salon_id") as string | null;

  if (!file || !salonId) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({ error: "invalid_type" }, { status: 400 });
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "file_too_large" }, { status: 400 });
  }

  const ext = file.type === "image/png" ? "png" : "jpg";
  const tempId = randomUUID();
  const refPath = `${salonId}/${tempId}.${ext}`;

  const db = createServiceRoleClient();
  const bytes = await file.arrayBuffer();

  const { error } = await db.storage
    .from("booking-refs")
    .upload(refPath, bytes, {
      contentType: file.type,
      upsert: false,
    });

  if (error) {
    console.error("[ref-upload] storage error", error.message);
    return NextResponse.json({ error: "upload_failed" }, { status: 500 });
  }

  return NextResponse.json({ ref_path: refPath });
}
