// Next.js API route — POST /api/staff/photo-upload
// Accepts multipart upload from PhotoCaptureForm.
// Handles: consent upsert, storage upload, booking_photos insert, fires photo-enhance async.

import { NextResponse } from "next/server";
import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export const dynamic = "force-dynamic";

type ConsentToggles = {
  consent_receive_sms: boolean;
  consent_save_to_profile: boolean;
  consent_share_public: boolean;
  consent_use_marketing: boolean;
};

function parseConsentToggles(raw: string): ConsentToggles | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ConsentToggles>;
    return {
      consent_receive_sms: parsed.consent_receive_sms ?? true,
      consent_save_to_profile: parsed.consent_save_to_profile ?? true,
      consent_share_public: parsed.consent_share_public ?? false,
      consent_use_marketing: parsed.consent_use_marketing ?? false,
    };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  // Auth check via session cookie
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parse multipart form
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const bookingId = (formData.get("booking_id") as string | null)?.trim();
  const photoFile = formData.get("photo") as File | null;
  const consentsRaw = (formData.get("consents") as string | null) ?? "{}";

  if (!bookingId) {
    return NextResponse.json({ error: "Missing booking_id" }, { status: 400 });
  }
  if (!photoFile || photoFile.size === 0) {
    return NextResponse.json({ error: "Missing photo" }, { status: 400 });
  }

  const consents = parseConsentToggles(consentsRaw) ?? {
    consent_receive_sms: true,
    consent_save_to_profile: true,
    consent_share_public: false,
    consent_use_marketing: false,
  };

  // Validate file size (max 20MB)
  const MAX_SIZE_BYTES = 20 * 1024 * 1024;
  if (photoFile.size > MAX_SIZE_BYTES) {
    return NextResponse.json({ error: "Photo too large (max 20MB)" }, { status: 413 });
  }

  const db = createServiceRoleClient();

  // Fetch booking — must be completed
  const { data: booking, error: bookingErr } = await db
    .from("bookings")
    .select("id, salon_id, status, staff_id, client_phone")
    .eq("id", bookingId)
    .is("deleted_at", null)
    .maybeSingle();

  if (bookingErr || !booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  if (booking.status !== "completed") {
    return NextResponse.json(
      { error: "Booking must be completed before uploading a photo" },
      { status: 422 },
    );
  }

  const salonId: string = booking.salon_id;

  // Verify caller is a member of this salon
  const { data: membership } = await db
    .from("salon_members")
    .select("id, role")
    .eq("salon_id", salonId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Upsert customer_photo_consents if booking has a client phone
  const clientPhone = (booking.client_phone as string | null)?.trim() ?? null;
  if (clientPhone) {
    const { error: consentErr } = await db
      .from("customer_photo_consents")
      .upsert(
        {
          salon_id: salonId,
          client_phone: clientPhone,
          consent_receive_sms: consents.consent_receive_sms,
          consent_save_to_profile: consents.consent_save_to_profile,
          consent_share_public: consents.consent_share_public,
          consent_use_marketing: consents.consent_use_marketing,
          granted_by_staff_id: membership.id,
          granted_via: "staff_photo_upload",
          granted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "salon_id,client_phone",
          ignoreDuplicates: false,
        },
      );

    if (consentErr) {
      console.error("[photo-upload] Consent upsert error:", consentErr);
      // Non-fatal — continue with upload
    }
  }

  // Upload photo to Supabase Storage
  const photoId = crypto.randomUUID();
  const originalName = photoFile.name ?? "photo.jpg";
  const ext = originalName.includes(".") ? originalName.split(".").pop()! : "jpg";
  const storagePath = `${salonId}/${bookingId}/${photoId}.${ext}`;

  const photoBytes = await photoFile.arrayBuffer();
  const { error: uploadError } = await db.storage
    .from("booking-photos")
    .upload(storagePath, photoBytes, {
      contentType: photoFile.type || "image/jpeg",
      upsert: false,
    });

  if (uploadError) {
    console.error("[photo-upload] Storage error:", uploadError);
    return NextResponse.json({ error: "Storage upload failed" }, { status: 500 });
  }

  // Insert booking_photos row
  const { data: photoRow, error: insertError } = await db
    .from("booking_photos")
    .insert({
      id: photoId,
      booking_id: bookingId,
      salon_id: salonId,
      staff_id: (booking.staff_id as string | null) ?? null,
      storage_path: storagePath,
      file_size_bytes: photoFile.size,
    })
    .select("id, storage_path")
    .single();

  if (insertError) {
    console.error("[photo-upload] DB insert error:", insertError);
    // Clean up storage on insert failure
    await db.storage.from("booking-photos").remove([storagePath]);
    return NextResponse.json({ error: "Failed to record photo" }, { status: 500 });
  }

  // Fire-and-forget: call photo-enhance edge function asynchronously
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (supabaseUrl) {
    const enhanceUrl = `${supabaseUrl}/functions/v1/photo-enhance`;
    // Fire without awaiting — let it run in background
    fetch(enhanceUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ photo_id: photoId }),
    }).catch((err) => {
      console.error("[photo-upload] Failed to trigger photo-enhance:", err);
    });
  }

  return NextResponse.json({ photo_id: photoRow.id }, { status: 201 });
}
