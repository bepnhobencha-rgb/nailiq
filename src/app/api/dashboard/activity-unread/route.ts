import { NextResponse, type NextRequest } from "next/server";

import { getActivityUnreadCount } from "@/shared/dashboard/loadActivityFeedAction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const slug = request.nextUrl.searchParams.get("slug")?.trim() ?? "";
  const since = request.nextUrl.searchParams.get("since")?.trim() ?? "";
  if (
    !slug ||
    slug.length > 120 ||
    !since ||
    !Number.isFinite(Date.parse(since))
  ) {
    return NextResponse.json(
      { ok: false },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await getActivityUnreadCount(slug, since);
  return NextResponse.json(result, {
    status: result.ok ? 200 : 403,
    headers: { "Cache-Control": "no-store" },
  });
}
