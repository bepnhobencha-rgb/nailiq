// POST /api/errors — public endpoint for client-side error reports
// (window.onerror / unhandledrejection / React error boundaries). Dedup +
// row-growth control happen in the log_error RPC, so a noisy client can't
// explode the table. No auth: anonymous guests on the public booking page hit
// errors too, and we want those.

import { NextRequest, NextResponse } from "next/server";
import { logError } from "@/shared/observability/errorLog";
import { resolveSalonIdFromRoute } from "@/shared/observability/tenantRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    message?: unknown;
    level?: unknown;
    route?: unknown;
    stack?: unknown;
    context?: unknown;
  } | null;

  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ ok: false }, { status: 400 });

  const level = body?.level === "warning" ? "warning" : "error";
  const context: Record<string, unknown> =
    body?.context && typeof body.context === "object" ? (body.context as Record<string, unknown>) : {};
  context.ua = (req.headers.get("user-agent") ?? "").slice(0, 200);
  const route = typeof body?.route === "string" ? body.route.slice(0, 300) : null;
  const salonId = await resolveSalonIdFromRoute(route).catch(() => null);

  await logError({
    message: message.slice(0, 2000),
    level,
    surface: "client",
    route,
    salonId,
    stack: typeof body?.stack === "string" ? body.stack.slice(0, 8000) : null,
    context,
  });

  return NextResponse.json({ ok: true });
}
