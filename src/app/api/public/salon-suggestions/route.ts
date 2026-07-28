import { NextResponse } from "next/server";

import { fetchSimilarSalonSlugs } from "@/shared/booking/getSalonBySlug";
import {
  normalizePublicBookingSlug,
  validatePublicBookingSlug,
} from "@/shared/booking/normalizePublicBookingSlug";
import { createPublicClient } from "@/shared/lib/supabase/publicClient";

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
