// Supabase Edge Function — pattern-detector
// Analyzes completed bookings per customer and upserts customer_booking_patterns.
// Called as a daily cron or triggered after a booking completes.
// POST { salon_id?: string }  — if omitted, processes all salons.

import { createClient } from "npm:@supabase/supabase-js@2";
import { rejectUnauthorizedInternalRequest } from "../_shared/internalAuth.ts";
import { supabaseSecretKey } from "../_shared/supabaseApiKeys.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = supabaseSecretKey();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Returns the statistical mode of an array of numbers, or null if empty. */
function mode(values: number[]): number | null {
  if (values.length === 0) return null;
  const freq = new Map<number, number>();
  for (const v of values) freq.set(v, (freq.get(v) ?? 0) + 1);
  let bestVal = values[0];
  let bestCount = 0;
  for (const [val, count] of freq) {
    if (count > bestCount) {
      bestCount = count;
      bestVal = val;
    }
  }
  return bestVal;
}

/** Returns the median of an array of numbers, or null if empty. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Coefficient of variation (stddev / mean). Returns Infinity if mean is 0. */
function coeffVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (mean === 0) return Infinity;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

type BookingRow = {
  id: string;
  start_time_utc: string;
  service_id: string;
  staff_id: string | null;
  client_phone: string | null;
  price_cents: number | null;
  salon_id: string;
};

async function processOneSalon(
  supabase: ReturnType<typeof createClient>,
  salonId: string,
): Promise<{ processed: number; errors: number }> {
  // Find phones with ≥3 completed bookings in this salon
  const { data: phoneCounts } = await supabase
    .from("bookings")
    .select("client_phone")
    .eq("salon_id", salonId)
    .eq("status", "completed")
    .not("client_phone", "is", null)
    .not("start_time_utc", "is", null);

  if (!phoneCounts) return { processed: 0, errors: 0 };

  // Aggregate counts per phone
  const countMap = new Map<string, number>();
  for (const row of phoneCounts) {
    if (row.client_phone) {
      countMap.set(row.client_phone, (countMap.get(row.client_phone) ?? 0) + 1);
    }
  }

  const eligiblePhones = [...countMap.entries()]
    .filter(([, count]) => count >= 3)
    .map(([phone]) => phone);

  let processed = 0;
  let errors = 0;

  for (const phone of eligiblePhones) {
    try {
      // Fetch last 6 completed bookings ordered desc
      const { data: bookings } = await supabase
        .from("bookings")
        .select("id, start_time_utc, service_id, staff_id, client_phone, price_cents, salon_id")
        .eq("salon_id", salonId)
        .eq("client_phone", phone)
        .eq("status", "completed")
        .not("start_time_utc", "is", null)
        .order("start_time_utc", { ascending: false })
        .limit(6);

      if (!bookings || bookings.length < 3) continue;

      const rows = bookings as BookingRow[];

      // Extract day-of-week (0=Sun..6=Sat) and hour per booking
      const weekdays: number[] = [];
      const hours: number[] = [];
      const timestamps: number[] = [];

      for (const b of rows) {
        const d = new Date(b.start_time_utc);
        weekdays.push(d.getUTCDay());
        hours.push(d.getUTCHours());
        timestamps.push(d.getTime());
      }

      // Compute recurrence frequency (median days between consecutive bookings)
      const gapDays: number[] = [];
      for (let i = 0; i < timestamps.length - 1; i++) {
        // timestamps sorted desc, so [i] > [i+1]
        const diffDays = (timestamps[i] - timestamps[i + 1]) / (1000 * 60 * 60 * 24);
        gapDays.push(Math.round(diffDays));
      }
      const recurrenceFrequencyDays = median(gapDays);

      // Mode for weekday and hour
      const recurringWeekday = mode(weekdays);
      const recurringHour = mode(hours);

      // Usual services: appearing in ≥60% of bookings
      const serviceFreq = new Map<string, number>();
      for (const b of rows) {
        serviceFreq.set(b.service_id, (serviceFreq.get(b.service_id) ?? 0) + 1);
      }
      const threshold60 = rows.length * 0.6;
      const usualServiceIds = [...serviceFreq.entries()]
        .filter(([, count]) => count >= threshold60)
        .map(([id]) => id);

      // Usual staff: appearing in ≥60% of bookings
      const staffFreq = new Map<string, number>();
      for (const b of rows) {
        if (b.staff_id) {
          staffFreq.set(b.staff_id, (staffFreq.get(b.staff_id) ?? 0) + 1);
        }
      }
      const usualStaffEntries = [...staffFreq.entries()].filter(
        ([, count]) => count >= threshold60,
      );
      const usualStaffId = usualStaffEntries.length > 0 ? usualStaffEntries[0][0] : null;

      // Pattern confidence scoring
      let confidence = 0.0;

      // +0.3 if weekday consistency ≥80%
      const weekdayModeVal = recurringWeekday;
      if (weekdayModeVal !== null) {
        const weekdayCount = weekdays.filter((w) => w === weekdayModeVal).length;
        if (weekdayCount / weekdays.length >= 0.8) confidence += 0.3;
      }

      // +0.2 if hour consistency ≥80%
      const hourModeVal = recurringHour;
      if (hourModeVal !== null) {
        const hourCount = hours.filter((h) => h === hourModeVal).length;
        if (hourCount / hours.length >= 0.8) confidence += 0.2;
      }

      // +0.2 if service combo ≥60%
      if (usualServiceIds.length > 0) confidence += 0.2;

      // +0.2 if same staff ≥60%
      if (usualStaffId) confidence += 0.2;

      // +0.1 if frequency variance < 20% (CV < 0.2)
      if (gapDays.length > 0 && coeffVariation(gapDays) < 0.2) confidence += 0.1;

      confidence = Math.min(1.0, Math.round(confidence * 100) / 100);

      // Compute next_predicted_at
      const lastBookingAt = rows[0].start_time_utc;
      let nextPredictedAt: string | null = null;
      if (recurrenceFrequencyDays !== null && recurrenceFrequencyDays > 0) {
        const lastMs = new Date(lastBookingAt).getTime();
        nextPredictedAt = new Date(
          lastMs + recurrenceFrequencyDays * 24 * 60 * 60 * 1000,
        ).toISOString();
      }

      // Usual total cents: median of price_cents
      const priceSamples = rows
        .map((b) => b.price_cents)
        .filter((p): p is number => p !== null);
      const usualTotalCents =
        priceSamples.length > 0 ? Math.round(median(priceSamples) ?? 0) : null;

      // Look up client_profile_id
      const { data: profile } = await supabase
        .from("client_profiles")
        .select("id")
        .eq("phone", phone)
        .maybeSingle();

      await supabase.from("customer_booking_patterns").upsert(
        {
          salon_id: salonId,
          client_phone: phone,
          client_profile_id: profile?.id ?? null,
          bookings_analyzed: rows.length,
          recurring_weekday: recurringWeekday,
          recurring_hour: recurringHour,
          recurrence_frequency_days: recurrenceFrequencyDays,
          usual_service_ids: usualServiceIds.length > 0 ? usualServiceIds : null,
          usual_staff_id: usualStaffId,
          pattern_confidence: confidence,
          last_booking_at: lastBookingAt,
          next_predicted_at: nextPredictedAt,
          usual_total_cents: usualTotalCents,
          last_computed_at: new Date().toISOString(),
          next_refresh_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "salon_id,client_phone" },
      );

      processed++;
    } catch (err) {
      console.error(`[pattern-detector] Error processing ${phone}:`, err);
      errors++;
    }
  }

  return { processed, errors };
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

  let body: { salon_id?: string } = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is fine — process all salons
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let salonIds: string[];

  if (body.salon_id) {
    salonIds = [body.salon_id];
  } else {
    // Process all active (non-archived) salons
    const { data: salons } = await supabase
      .from("salons")
      .select("id")
      .is("archived_at", null);
    salonIds = (salons ?? []).map((s: { id: string }) => s.id);
  }

  const results: Array<{ salon_id: string; processed: number; errors: number }> = [];

  for (const salonId of salonIds) {
    const result = await processOneSalon(supabase, salonId);
    results.push({ salon_id: salonId, ...result });
  }

  const totalProcessed = results.reduce((s, r) => s + r.processed, 0);
  const totalErrors = results.reduce((s, r) => s + r.errors, 0);

  console.log(
    `[pattern-detector] Done. salons=${salonIds.length} patterns_computed=${totalProcessed} errors=${totalErrors}`,
  );

  return jsonOk({
    ok: true,
    salons_processed: salonIds.length,
    patterns_computed: totalProcessed,
    errors: totalErrors,
    detail: results,
  });
});
