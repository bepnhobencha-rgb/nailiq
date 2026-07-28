import { NextResponse } from "next/server";

/**
 * Liveness endpoint for uptime monitors. No DB, no auth — answers
 * "is the Node.js runtime serving requests?" only. Returns 200 + JSON
 * payload so monitors can also assert content type / shape.
 *
 * Deeper database/schema readiness is exposed separately at `/api/ready`,
 * keeping liveness stable during a transient dependency incident.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

const VERSION = process.env.npm_package_version ?? "0.0.0";

export function GET() {
  return NextResponse.json(
    {
      status: "ok",
      timestamp: new Date().toISOString(),
      version: VERSION,
    },
    {
      status: 200,
      headers: {
        "cache-control": "no-store, no-cache, must-revalidate",
      },
    },
  );
}
