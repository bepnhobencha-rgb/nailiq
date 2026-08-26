import { NextResponse } from "next/server";

import { fetchSimilarSalonSlugs } from "@/shared/booking/getSalonBySlug";
import {
  normalizePublicBookingSlug,
  validatePublicBookingSlug,
} from "@/shared/booking/normalizePublicBookingSlug";
import { createPublicClient } from "@/shared/lib/supabase/publicClient";
import { consumePublicRequestRateLimit } from "@/shared/security/publicServerActionRateLimit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rawSlug = new URL(request.url).searchParams.get("slug") ?? "";
  const slug = normalizePublicBookingSlug(rawSlug);

  if (!validatePublicBookingSlug(slug)) {
    return NextResponse.json(
      { suggestions: [] },
      {
        headers: {
          "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
        },
      },
    );
  }


  const rate = await consumePublicRequestRateLimit({
    request,
    scope: "public-salon-suggestions",
    identity: [slug],
    ipLimits: [[30, 60], [300, 3_600]],
    identityLimits: [[60, 60], [500, 3_600]],
  });
  if (rate !== "allowed") {
    return NextResponse.json(
      { suggestions: [], error: rate === "limited" ? "rate_limited" : "temporarily_unavailable" },
      { status: rate === "limited" ? 429 : 503 },
    );
  }

  const suggestions = (await fetchSimilarSalonSlugs(
    createPublicClient(),
    slug,
  ))
    .filter((suggestion) => suggestion !== slug)
    .slice(0, 3);

  return NextResponse.json(
    { suggestions },
    {
      headers: {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
      },
    },
  );
}
