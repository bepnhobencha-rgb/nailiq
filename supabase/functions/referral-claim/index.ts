// Supabase Edge Function — referral-claim
// Called when a customer submits a booking with a referral code.
// POST { salon_id, code, referee_phone, referee_booking_id? }

import { createClient } from "npm:@supabase/supabase-js@2";
import { rejectUnauthorizedInternalRequest } from "../_shared/internalAuth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

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

  const unauthorized = await rejectUnauthorizedInternalRequest(req, corsHeaders);
  if (unauthorized) return unauthorized;

  let body: {
    salon_id?: string;
    code?: string;
    referee_phone?: string;
    referee_booking_id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON");
  }

  const { salon_id, code, referee_phone, referee_booking_id } = body;

  if (!salon_id || !code || !referee_phone) {
    return jsonError("Missing required fields: salon_id, code, referee_phone");
  }

  const normalizedPhone = referee_phone.trim();
  const normalizedCode = code.trim().toUpperCase();

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Look up the referral by salon + code
  const { data: referral, error: lookupError } = await supabase
    .from("referrals")
    .select(
      "id, referrer_phone, referee_phone, status, expires_at, referee_reward_percent_off",
    )
    .eq("salon_id", salon_id)
    .eq("code", normalizedCode)
    .maybeSingle();

  if (lookupError) {
    console.error("[referral-claim] lookup error:", lookupError);
    return jsonError("Database error", 500);
  }

  if (!referral) {
    return jsonError("invalid_code", 404);
  }

  // Validate: must be pending
  if (referral.status !== "pending") {
    return jsonError("code_already_used");
  }

  // Validate: must not be expired
  if (referral.expires_at && new Date(referral.expires_at) < new Date()) {
    return jsonError("code_expired");
  }

  // Validate: no self-referral
  if (referral.referrer_phone === normalizedPhone) {
    return jsonError("self_referral_not_allowed");
  }

  // Validate: referee slot not already taken
  if (referral.referee_phone && referral.referee_phone !== normalizedPhone) {
    return jsonError("code_already_assigned");
  }

  // Update the referral row
  const updatePayload: Record<string, unknown> = {
    referee_phone: normalizedPhone,
    status: "used",
    used_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (referee_booking_id) {
    updatePayload.referee_booking_id = referee_booking_id;
  }

  const { error: updateError } = await supabase
    .from("referrals")
    .update(updatePayload)
    .eq("id", referral.id);

  if (updateError) {
    console.error("[referral-claim] update error:", updateError);
    return jsonError("Failed to claim referral", 500);
  }

  return jsonOk({
    ok: true,
    referral_id: referral.id,
    referee_reward_percent_off: referral.referee_reward_percent_off ?? 10,
  });
});
