// Supabase Edge Function — photo-upload
// Accepts multipart/form-data: { booking_id, photo: File }
// Auth: Bearer token (authenticated salon member)
// Validates booking, checks salon tier (Pro+), uploads to storage, inserts booking_photos row.

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  supabasePublishableKey,
  supabaseSecretKey,
} from "../_shared/supabaseApiKeys.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = supabaseSecretKey();
const ANON_KEY = supabasePublishableKey();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonError("Method not allowed", 405);
  }

  // Verify Bearer token and get user context
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return jsonError("Missing authorization token", 401);
  }

  // User-scoped client to identify the caller
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });

  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) {
    return jsonError("Unauthorized", 401);
  }

  // Parse multipart form
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return jsonError("Invalid multipart form data");
  }

  const bookingId = (formData.get("booking_id") as string | null)?.trim();
  const photoFile = formData.get("photo") as File | null;

  if (!bookingId) return jsonError("Missing booking_id");
  if (!photoFile) return jsonError("Missing photo file");

  // Service role client for privileged reads/writes
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Fetch booking — must be completed
  const { data: booking, error: bookingErr } = await db
    .from("bookings")
    .select("id, salon_id, status, staff_id")
    .eq("id", bookingId)
    .is("deleted_at", null)
    .maybeSingle();

  if (bookingErr || !booking) {
    return jsonError("Booking not found", 404);
  }
  if (booking.status !== "completed") {
    return jsonError("Booking must be completed before uploading a photo");
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
    return jsonError("Forbidden: not a member of this salon", 403);
  }

  // Check salon is Pro+ (has photo_confirmation feature)
  const { data: salon } = await db
    .from("salons")
    .select("subscription_plan, plan_override, feature_flags")
    .eq("id", salonId)
    .maybeSingle();

  if (!salon) {
    return jsonError("Salon not found", 404);
  }

  const hasPhotoConfirmation = (() => {
    const flags = salon.feature_flags as Record<string, boolean> | null;
    if (flags && typeof flags["photo_confirmation"] === "boolean") {
      return flags["photo_confirmation"];
    }
    const plan = (salon.plan_override ?? salon.subscription_plan) as string;
    const planFeatures: Record<string, string[]> = {
      free: [],
      pro: ["photo_confirmation"],
      premium: ["photo_confirmation"],
      enterprise: ["photo_confirmation"],
    };
    return planFeatures[plan]?.includes("photo_confirmation") ?? false;
  })();

  if (!hasPhotoConfirmation) {
    return jsonError("Photo confirmation requires Pro plan or higher", 403);
  }

  // Build storage path
  const photoId = crypto.randomUUID();
  const originalName = photoFile.name ?? "photo.jpg";
  const ext = originalName.includes(".") ? originalName.split(".").pop()! : "jpg";
  const storagePath = `${salonId}/${bookingId}/${photoId}.${ext}`;

  // Upload to storage bucket 'booking-photos'
  const photoBytes = await photoFile.arrayBuffer();
  const { error: uploadError } = await db.storage
    .from("booking-photos")
    .upload(storagePath, photoBytes, {
      contentType: photoFile.type || "image/jpeg",
      upsert: false,
    });

  if (uploadError) {
    console.error("[photo-upload] Storage upload error:", uploadError);
    return jsonError("Failed to upload photo", 500);
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
    // Clean up the uploaded file on insert failure
    await db.storage.from("booking-photos").remove([storagePath]);
    return jsonError("Failed to record photo", 500);
  }

  return new Response(
    JSON.stringify({ photo_id: photoRow.id, storage_path: photoRow.storage_path }),
    {
      status: 201,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
