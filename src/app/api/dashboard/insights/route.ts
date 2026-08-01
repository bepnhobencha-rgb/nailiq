import { NextResponse } from "next/server";

import {
  loadSalonReports,
  type ReportsDateRange,
} from "@/shared/dashboard/loadSalonReports";

export const dynamic = "force-dynamic";

const VALID_RANGES = new Set<ReportsDateRange>(["today", "week", "month"]);

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const slug = searchParams.get("slug")?.trim() ?? "";
  const range = searchParams.get("range") as ReportsDateRange | null;

  if (!slug || !range || !VALID_RANGES.has(range)) {
    return NextResponse.json(
      { ok: false, error: "server_error" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await loadSalonReports(slug, range);
  const status = result.ok
    ? 200
    : result.error === "unauthorized"
      ? 401
      : result.error === "forbidden"
        ? 403
        : result.error === "feature_not_enabled"
          ? 404
          : 500;

  return NextResponse.json(result, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
