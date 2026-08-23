import { createHash } from "node:crypto";

import { expect, request as playwrightRequest, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { cleanupTestSalon, seedTestSalon } from "./helpers/db";

function positiveInteger(raw: string | undefined, fallback: number) {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const MQA_ID = process.env.MQA_LOAD_ID?.trim() || "MQA-0147";
const TOTAL_USERS = positiveInteger(process.env.MQA_LOAD_TOTAL_USERS, 100);
const PUBLIC_USERS = Math.round(TOTAL_USERS * 0.7);
const DASHBOARD_USERS = TOTAL_USERS - PUBLIC_USERS;
const P95_SLA_MS = positiveInteger(process.env.MQA_LOAD_P95_SLA_MS, 3_000);
const MAX_SLA_MS = positiveInteger(process.env.MQA_LOAD_MAX_SLA_MS, 10_000);
const SLUG = `e2e-${MQA_ID.toLowerCase()}-${TOTAL_USERS}-user-load`;
const SALON_NAME = `E2E ${MQA_ID} ${TOTAL_USERS} User Load Salon`;
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
let loadStartedAtMs = 0;

function percentileNearestRank(samples: readonly number[], percentile: number) {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1]!;
}

function summarize(samples: readonly number[]) {
  return {
    count: samples.length,
    p50Ms: percentileNearestRank(samples, 0.5),
    p95Ms: percentileNearestRank(samples, 0.95),
    maxMs: Math.max(...samples),
  };
}

function testIp(identity: string) {
  const digest = createHash("sha256").update(identity).digest("hex");
  return `2001:db8::${digest.slice(0, 4)}:${digest.slice(4, 8)}`;
}

async function cleanupExactRateLimitBuckets() {
  if (loadStartedAtMs <= 0) return;
  const finishedAtMs = Date.now();
  const buckets: string[] = [];
  for (let index = 0; index < PUBLIC_USERS; index += 1) {
    const ip = testIp(`${SLUG}:booking:${index}`);
    for (const [name, seconds] of [["minute", 60], ["hour", 3_600]] as const) {
      const digest = createHash("sha256")
        .update(JSON.stringify(["booking-page", name, ip]))
        .digest("hex");
      const base = `public-edge:booking-page:${name}:${digest}`;
      const firstWindow = Math.floor(loadStartedAtMs / 1_000 / seconds) - 1;
      const lastWindow = Math.floor(finishedAtMs / 1_000 / seconds) + 1;
      for (let window = firstWindow; window <= lastWindow; window += 1) {
        buckets.push(`${base}:${window}`);
      }
    }
  }
  for (let offset = 0; offset < buckets.length; offset += 50) {
    const { error } = await db
      .from("rate_limits")
      .delete()
      .in("bucket", buckets.slice(offset, offset + 50));
    if (error) throw new Error(`cleanup exact load buckets: ${error.message}`);
  }
}

async function seedRepresentativeVolume(salonId: string) {
  const [{ data: service }, { data: staff }] = await Promise.all([
    db.from("services").select("id, price_cents").eq("salon_id", salonId).single(),
    db.from("staff").select("id").eq("salon_id", salonId).single(),
  ]);
  expect(service?.id).toBeTruthy();
  expect(staff?.id).toBeTruthy();

  const nowMs = Date.now();
  const rows = Array.from({ length: 250 }, (_, index) => {
    const startMs = nowMs - (index + 1) * 60 * 60 * 1000;
    return {
      salon_id: salonId,
      service_id: service!.id,
      staff_id: staff!.id,
      client_name: `Load Guest ${String(index + 1).padStart(3, "0")}`,
      client_phone: null,
      client_notes: null,
      start_time_utc: new Date(startMs).toISOString(),
      end_time_utc: new Date(startMs + 45 * 60 * 1000).toISOString(),
      status: "completed",
      source: "appointment",
      price_cents: Number(service!.price_cents),
    };
  });
  const { error } = await db.from("bookings").insert(rows);
  if (error) throw new Error(`seed 100-user representative volume: ${error.message}`);
}

test.describe(`${MQA_ID} — ${TOTAL_USERS} concurrent users`, () => {
  test.beforeAll(async () => {
    const salon = await seedTestSalon({
      slug: SLUG,
      name: SALON_NAME,
      phone: "15553336666",
    });
    await seedRepresentativeVolume(salon.salonId);
  });

  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
    await cleanupExactRateLimitBuckets();
  });

  test(`${PUBLIC_USERS} public-booking and ${DASHBOARD_USERS} dashboard users start together with zero failures`, async ({
    baseURL,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium",
      "The protocol-level load distribution is measured once",
    );
    test.setTimeout(3 * 60_000);
    expect(
      process.env.MQA_LOAD_SERVER_MODE,
      "Load evidence must run against the optimized local production build",
    ).toBe("production-build");
    expect(baseURL).toBeTruthy();

    const users = Array.from({ length: TOTAL_USERS }, (_, index) => {
      const kind = index < PUBLIC_USERS ? "booking" : "dashboard";
      return { index, kind } as const;
    });
    const contexts = await Promise.all(
      users.map(({ index, kind }) =>
        playwrightRequest.newContext({
          baseURL,
          extraHTTPHeaders: {
            accept: "text/html",
            "x-forwarded-for": testIp(`${SLUG}:${kind}:${index}`),
            ...(kind === "dashboard"
              ? { cookie: `nailiq-demo-slug=${SLUG}` }
              : {}),
          },
        }),
      ),
    );

    let release!: () => void;
    const startGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    loadStartedAtMs = Date.now();
    const startedWallAt = performance.now();
    const tasks = users.map(async ({ index, kind }) => {
      await startGate;
      const startedAt = performance.now();
      const path = kind === "booking"
        ? `/${SLUG}?load_user=${index}`
        : `/dashboard/${SLUG}?load_user=${index}`;
      try {
        const response = await contexts[index]!.get(path);
        const body = await response.text();
        return {
          index,
          kind,
          status: response.status(),
          ok: response.ok(),
          redirectedToLogin: response.url().includes("/login") || response.url().includes("/register"),
          correctTenant: body.includes(SALON_NAME),
          elapsedMs: Math.round(performance.now() - startedAt),
          error: null as string | null,
        };
      } catch (error) {
        return {
          index,
          kind,
          status: 0,
          ok: false,
          redirectedToLogin: false,
          correctTenant: false,
          elapsedMs: Math.round(performance.now() - startedAt),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    release();
    const results = await Promise.all(tasks);
    const wallMs = Math.round(performance.now() - startedWallAt);
    await Promise.all(contexts.map((context) => context.dispose()));

    const failures = results.filter(
      (result) =>
        !result.ok ||
        result.status !== 200 ||
        result.redirectedToLogin ||
        !result.correctTenant ||
        result.error,
    );
    const bookingSamples = results
      .filter((result) => result.kind === "booking")
      .map((result) => result.elapsedMs);
    const dashboardSamples = results
      .filter((result) => result.kind === "dashboard")
      .map((result) => result.elapsedMs);
    const allSamples = results.map((result) => result.elapsedMs);
    const result = {
      serverMode: process.env.MQA_LOAD_SERVER_MODE,
      users: {
        total: TOTAL_USERS,
        publicBooking: PUBLIC_USERS,
        dashboard: DASHBOARD_USERS,
      },
      representativeHistoricalBookings: 250,
      startModel: `all ${TOTAL_USERS} independent request contexts released by one barrier`,
      readOnly: true,
      thresholds: {
        failedRequests: 0,
        p95Ms: P95_SLA_MS,
        maxMs: MAX_SLA_MS,
      },
      wallMs,
      booking: summarize(bookingSamples),
      dashboard: summarize(dashboardSamples),
      overall: summarize(allSamples),
      failureCount: failures.length,
      failureSample: failures.slice(0, 10),
    };
    console.info(`[${MQA_ID}] ${JSON.stringify(result)}`);
    await testInfo.attach(`${MQA_ID.toLowerCase()}-${TOTAL_USERS}-user-load.json`, {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });

    expect(failures, "every concurrent user must receive the correct tenant page").toEqual([]);
    expect(result.booking.p95Ms, "public booking p95").toBeLessThan(P95_SLA_MS);
    expect(result.dashboard.p95Ms, "dashboard p95").toBeLessThan(P95_SLA_MS);
    expect(result.overall.p95Ms, "overall p95").toBeLessThan(P95_SLA_MS);
    expect(result.overall.maxMs, "overall max").toBeLessThan(MAX_SLA_MS);
  });
});
