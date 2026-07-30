import { NextResponse, type NextRequest } from "next/server";

import { upsertPresence } from "@/shared/dashboard/presenceActions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === request.nextUrl.origin;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return NextResponse.json(
      { ok: false },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const body = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  const salonId =
    typeof body?.salonId === "string" && UUID_PATTERN.test(body.salonId)
      ? body.salonId
      : "";
  const currentPath =
    typeof body?.currentPath === "string" && body.currentPath.length <= 300
      ? body.currentPath
      : "";
  const batteryLevel =
    body?.batteryLevel === null ||
    (Number.isInteger(body?.batteryLevel) &&
      Number(body?.batteryLevel) >= 0 &&
      Number(body?.batteryLevel) <= 100)
      ? (body?.batteryLevel as number | null)
      : undefined;
  if (!salonId || !currentPath || batteryLevel === undefined) {
    return NextResponse.json(
      { ok: false },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await upsertPresence({
    salonId,
    currentPath,
    batteryLevel,
    userAgent: request.headers.get("user-agent") ?? undefined,
  });
  return NextResponse.json(result, {
    status: result.ok ? 200 : 401,
    headers: { "Cache-Control": "no-store" },
  });
}
