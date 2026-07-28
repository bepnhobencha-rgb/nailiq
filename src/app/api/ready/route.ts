import { NextResponse } from "next/server";

import {
  probeProductionReadiness,
  REQUIRED_SCHEMA_CAPABILITY,
} from "@/shared/operations/productionReadiness";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const VERSION = process.env.npm_package_version ?? "0.0.0";
const NO_STORE_HEADERS = {
  "cache-control": "no-store, no-cache, must-revalidate",
};

export async function GET() {
  const readiness = await probeProductionReadiness();
  const ready = readiness.ready;

  return NextResponse.json(
    {
      status: ready ? "ready" : "not_ready",
      timestamp: new Date().toISOString(),
      version: VERSION,
      checks: {
        database_schema: {
          status: ready ? "ok" : "error",
          capability: REQUIRED_SCHEMA_CAPABILITY,
          ...(!ready ? { reason: readiness.reason } : {}),
        },
      },
    },
    {
      status: ready ? 200 : 503,
      headers: NO_STORE_HEADERS,
    },
  );
}
