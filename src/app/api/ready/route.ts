import { NextResponse } from "next/server";

import {
  probeProductionReadiness,
  REQUIRED_SCHEMA_CAPABILITY,
} from "@/shared/operations/productionReadiness";
import { isCronAuthorizationConfigured } from "@/shared/security/cronAuthorization";
import { deploymentIdentity } from "@/shared/operations/deploymentIdentity";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = {
  "cache-control": "no-store, no-cache, must-revalidate",
};

export async function GET() {
  const readiness = await probeProductionReadiness();
  const cronAuthorizationConfigured =
    isCronAuthorizationConfigured();
  const ready = readiness.ready && cronAuthorizationConfigured;

  return NextResponse.json(
    {
      status: ready ? "ready" : "not_ready",
      timestamp: new Date().toISOString(),
      version: deploymentIdentity(),
      checks: {
        database_schema: {
          status: readiness.ready ? "ok" : "error",
          capability: REQUIRED_SCHEMA_CAPABILITY,
          ...(!readiness.ready ? { reason: readiness.reason } : {}),
        },
        cron_authorization: {
          status: cronAuthorizationConfigured ? "ok" : "error",
          ...(!cronAuthorizationConfigured
            ? { reason: "cron_secret_not_configured" }
            : {}),
        },
      },
    },
    {
      status: ready ? 200 : 503,
      headers: NO_STORE_HEADERS,
    },
  );
}
