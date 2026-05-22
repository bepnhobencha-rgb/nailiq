import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const db = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const body = await req.json().catch(() => ({}));
  const targetSalonId: string | undefined = body.salon_id;

  // Only Studio+ (premium/enterprise) salons get AI trends
  const salonQuery = db
    .from("salons")
    .select("id, subscription_plan, plan_override, feature_flags")
    .in("subscription_plan", ["premium", "enterprise"])
    .is("archived_at", null);

  if (targetSalonId) salonQuery.eq("id", targetSalonId);

  const { data: salons, error: salonsErr } = await salonQuery;
  if (salonsErr) {
    console.error("fetch salons error", salonsErr);
    return new Response(JSON.stringify({ error: salonsErr.message }), { status: 500 });
  }

  const results: Array<{ salon_id: string; trend_count: number; error?: string }> = [];

  for (const salon of salons ?? []) {
    try {
      const trendCount = await refreshTrendsForSalon(salon.id);
      results.push({ salon_id: salon.id, trend_count: trendCount });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`trend refresh failed for salon ${salon.id}:`, msg);
      results.push({ salon_id: salon.id, trend_count: 0, error: msg });
    }
  }

  return new Response(JSON.stringify({ ok: true, results }), {
    headers: { "content-type": "application/json" },
  });
});

async function refreshTrendsForSalon(salonId: string): Promise<number> {
  // Query recent high-quality photos with public consent
  const { data: photos, error } = await db
    .from("booking_photos")
    .select(`
      id,
      ai_detected_style,
      ai_detected_colors,
      ai_detected_services,
      ai_quality_score,
      created_at,
      booking_id,
      bookings!inner(service_id, client_phone),
      customer_photo_consents!inner(consent_share_public, revoked_at)
    `)
    .eq("salon_id", salonId)
    .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .gte("ai_quality_score", 0.7)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) throw new Error(`photo query: ${error.message}`);

  // Filter for public consent + not revoked
  const eligible = (photos ?? []).filter((p: Record<string, unknown>) => {
    const consents = p.customer_photo_consents as Array<{ consent_share_public: boolean; revoked_at: string | null }>;
    return consents?.some((c) => c.consent_share_public && !c.revoked_at);
  });

  // Group by detected_style and build trend objects
  const styleGroups: Record<string, typeof eligible> = {};
  for (const photo of eligible) {
    const style = (photo.ai_detected_style as string) ?? "unknown";
    if (!styleGroups[style]) styleGroups[style] = [];
    styleGroups[style].push(photo);
  }

  // Build trends array — top styles by booking count
  const trends = Object.entries(styleGroups)
    .sort(([, a], [, b]) => b.length - a.length)
    .slice(0, 10)
    .map(([style, group]) => {
      const topPhoto = group[0];
      return {
        photo_id: topPhoto.id,
        style,
        colors: topPhoto.ai_detected_colors ?? [],
        services: topPhoto.ai_detected_services ?? [],
        booking_count: group.length,
        quality_score: topPhoto.ai_quality_score,
      };
    });

  // Upsert ai_trend_cache for this_week period
  const { error: upsertErr } = await db
    .from("ai_trend_cache")
    .upsert(
      {
        salon_id: salonId,
        period: "this_week",
        trends,
        trend_count: trends.length,
        computed_at: new Date().toISOString(),
        computed_by: "cron-trend-refresh",
        next_refresh_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
      { onConflict: "salon_id,period" }
    );

  if (upsertErr) throw new Error(`upsert trend cache: ${upsertErr.message}`);

  return trends.length;
}
