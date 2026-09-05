import { createHash } from "node:crypto";

import {
  expect,
  request as playwrightRequest,
  test,
  type Page,
} from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import {
  cleanupTestSalon,
  cleanupTestUser,
  seedTestSalon,
  seedTestSalonMember,
} from "./helpers/db";

function positiveInteger(raw: string | undefined, fallback: number) {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const MQA_ID = process.env.MQA_LOAD_ID?.trim() || "MQA-0147";
const TOTAL_REQUESTS = positiveInteger(
  process.env.MQA_LOAD_TOTAL_REQUESTS ?? process.env.MQA_LOAD_TOTAL_USERS,
  100,
);
const PUBLIC_REQUESTS = Math.round(TOTAL_REQUESTS * 0.7);
const DASHBOARD_REQUESTS = TOTAL_REQUESTS - PUBLIC_REQUESTS;
const P95_SLA_MS = positiveInteger(process.env.MQA_LOAD_P95_SLA_MS, 3_000);
const MAX_SLA_MS = positiveInteger(process.env.MQA_LOAD_MAX_SLA_MS, 10_000);
const SLUG = `e2e-${MQA_ID.toLowerCase()}-${TOTAL_REQUESTS}-request-load`;
const SALON_NAME = `E2E ${MQA_ID} ${TOTAL_REQUESTS} Request Load Salon`;
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
let loadStartedAtMs = 0;
let loadFinishedAtMs = 0;
let owner: Awaited<ReturnType<typeof seedTestSalonMember>> | undefined;
type RateLimitRow = {
  bucket: string;
  count: number;
  expires_at: string;
};
let rateLimitBaseline = new Map<string, RateLimitRow>();
const observedLoadBuckets = new Set<string>();
let authRateLimitCleanupCandidates: string[] = [];
let authLimiterProof:
  | {
      expectedDistinctRows: number;
      observedDistinctRows: number;
      everyCountOne: boolean;
      cleanupVerified: boolean;
    }
  | undefined;

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

async function loginAs(
  page: Page,
  account: { email: string; password: string },
) {
  const digest = createHash("sha256").update(account.email).digest("hex");
  const ip = `2001:db8::${digest.slice(0, 4)}:${digest.slice(4, 8)}`;
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": ip,
  });
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute(
    "data-hydrated",
    "true",
  );
  await page.locator('input[inputmode="email"]').fill(account.email);
  await page.locator('input[type="password"]').fill(account.password);
  const startedAtMs = Date.now();
  await page.getByTestId("password-signin-submit").click();
  await page.waitForURL(new RegExp(`/dashboard/${SLUG}`), { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: SALON_NAME })).toBeVisible({
    timeout: 15_000,
  });
  return { ip, startedAtMs, finishedAtMs: Date.now() };
}

function addWindowCandidates(
  buckets: Set<string>,
  base: string,
  windowSeconds: number,
  startedAtMs: number,
  finishedAtMs: number,
) {
  const firstWindow = Math.floor(startedAtMs / 1_000 / windowSeconds) - 1;
  const lastWindow = Math.floor(finishedAtMs / 1_000 / windowSeconds) + 1;
  for (let window = firstWindow; window <= lastWindow; window += 1) {
    buckets.add(`${base}:${window}`);
  }
}

function rateLimitBucketCandidates(startedAtMs: number, finishedAtMs: number) {
  const buckets = new Set<string>();
  for (let index = 0; index < PUBLIC_REQUESTS; index += 1) {
    const ip = testIp(`${SLUG}:booking:${index}`);
    for (const [name, seconds] of [["minute", 60], ["hour", 3_600]] as const) {
      const digest = createHash("sha256")
        .update(JSON.stringify(["booking-page", name, ip]))
        .digest("hex");
      const base = `public-edge:booking-page:${name}:${digest}`;
      addWindowCandidates(buckets, base, seconds, startedAtMs, finishedAtMs);
    }
  }
  return [...buckets];
}

function authRateLimitBucketCandidates(input: {
  email: string;
  ip: string;
  startedAtMs: number;
  finishedAtMs: number;
}) {
  const buckets = new Set<string>();
  for (const [name, seconds] of [
    ["five-minute", 300],
    ["hour", 3_600],
  ] as const) {
    const digest = createHash("sha256")
      .update(JSON.stringify(["auth", name, input.ip]))
      .digest("hex");
    addWindowCandidates(
      buckets,
      `public-edge:auth:${name}:${digest}`,
      seconds,
      input.startedAtMs,
      input.finishedAtMs,
    );
  }

  const email = input.email.trim().toLowerCase();
  for (const [name, material, seconds] of [
    ["ip-0", input.ip, 300],
    ["ip-1", input.ip, 3_600],
    ["identity-0", email, 300],
    ["identity-1", email, 3_600],
  ] as const) {
    const digest = createHash("sha256")
      .update(JSON.stringify([material]))
      .digest("hex");
    addWindowCandidates(
      buckets,
      `public:auth-password-signin:${name}:${digest}`,
      seconds,
      input.startedAtMs,
      input.finishedAtMs,
    );
  }
  return [...buckets];
}

async function deleteRateLimitBuckets(buckets: readonly string[]) {
  for (let offset = 0; offset < buckets.length; offset += 50) {
    const { error } = await db
      .from("rate_limits")
      .delete()
      .in("bucket", buckets.slice(offset, offset + 50));
    if (error) throw new Error(`cleanup exact load buckets: ${error.message}`);
  }
}

async function readRateLimitBuckets(buckets: readonly string[]) {
  const rows: RateLimitRow[] = [];
  for (let offset = 0; offset < buckets.length; offset += 50) {
    const { data, error } = await db
      .from("rate_limits")
      .select("bucket, count, expires_at")
      .in("bucket", buckets.slice(offset, offset + 50));
    if (error) throw new Error(`read exact load buckets: ${error.message}`);
    rows.push(...((data ?? []) as RateLimitRow[]));
  }
  return rows;
}

async function readRateLimitsByPrefix(prefix: string) {
  const rows: RateLimitRow[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db
      .from("rate_limits")
      .select("bucket, count, expires_at")
      .like("bucket", `${prefix}%`)
      .order("bucket")
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`read booking-page limiter snapshot: ${error.message}`);
    const page = (data ?? []) as RateLimitRow[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function readAllBookingPageRateLimits() {
  return readRateLimitsByPrefix("public-edge:booking-page:");
}

async function readAllAuthRateLimits() {
  const [edge, action] = await Promise.all([
    readRateLimitsByPrefix("public-edge:auth:"),
    readRateLimitsByPrefix("public:auth-password-signin:"),
  ]);
  return [...edge, ...action];
}

async function cleanupAuthRateLimits() {
  if (authRateLimitCleanupCandidates.length > 0) {
    await deleteRateLimitBuckets(authRateLimitCleanupCandidates);
    const exactLeftovers = await readRateLimitBuckets(
      authRateLimitCleanupCandidates,
    );
    if (exactLeftovers.length > 0) {
      throw new Error(
        `auth limiter cleanup left ${exactLeftovers.length} exact bucket(s)`,
      );
    }
  }
  if (process.env.NAILIQ_DISPOSABLE_DB === "1") {
    const leftovers = await readAllAuthRateLimits();
    if (leftovers.length > 0) {
      throw new Error(`auth limiter cleanup left ${leftovers.length} bucket(s)`);
    }
  }
}

async function prepareRateLimitBaseline() {
  const now = Date.now();
  const nearRunBuckets = rateLimitBucketCandidates(
    now - 2 * 60_000,
    now + 10 * 60_000,
  );
  await deleteRateLimitBuckets(nearRunBuckets);
  expect(await readRateLimitBuckets(nearRunBuckets)).toEqual([]);

  const rows = await readAllBookingPageRateLimits();
  rateLimitBaseline = new Map(rows.map((row) => [row.bucket, row]));
  if (process.env.NAILIQ_DISPOSABLE_DB === "1") {
    expect(
      rows,
      "exclusive disposable DB must start without booking-page limiter state",
    ).toEqual([]);
  }
}

async function cleanupRateLimitDelta() {
  const finishedAtMs = loadFinishedAtMs || Date.now();
  const exactCandidates =
    loadStartedAtMs > 0
      ? rateLimitBucketCandidates(loadStartedAtMs, finishedAtMs)
      : [];
  const cleanupKeys = new Set([...exactCandidates, ...observedLoadBuckets]);
  if (cleanupKeys.size > 0) {
    await deleteRateLimitBuckets([...cleanupKeys]);
  }

  const current = await readAllBookingPageRateLimits();
  const currentMap = new Map(current.map((row) => [row.bucket, row]));
  for (const [bucket, baseline] of rateLimitBaseline) {
    const row = currentMap.get(bucket);
    if (
      !row ||
      row.count !== baseline.count ||
      row.expires_at !== baseline.expires_at
    ) {
      throw new Error(`limiter cleanup changed pre-existing bucket ${bucket}`);
    }
  }
  const unexpected = current.filter((row) => !rateLimitBaseline.has(row.bucket));
  if (unexpected.length > 0) {
    throw new Error(
      `limiter cleanup left ${unexpected.length} booking-page bucket(s)`,
    );
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
  if (error) throw new Error(`seed request-load representative volume: ${error.message}`);
}

test.describe(`${MQA_ID} — ${TOTAL_REQUESTS} concurrent document requests`, () => {
  test.beforeAll(async ({ request, baseURL }) => {
    const expectedAppId = process.env.MQA_LOAD_EXPECTED_APP_ID?.trim();
    if (MQA_ID === "MQA-0148" && !expectedAppId) {
      throw new Error("MQA-0148 requires MQA_LOAD_EXPECTED_APP_ID");
    }
    if (expectedAppId) {
      if (!baseURL) throw new Error("PLAYWRIGHT_BASE_URL is required");
      const versionResponse = await request.get(`${baseURL}/api/version`);
      if (!versionResponse.ok()) {
        throw new Error(`/api/version returned ${versionResponse.status()}`);
      }
      const version: unknown = await versionResponse.json();
      if (
        !version ||
        typeof version !== "object" ||
        !("id" in version) ||
        version.id !== expectedAppId
      ) {
        throw new Error("running app identity does not match the pinned load build");
      }
    }

    const salon = await seedTestSalon({
      slug: SLUG,
      name: SALON_NAME,
      phone: "15553336666",
    });
    await seedRepresentativeVolume(salon.salonId);
    owner = await seedTestSalonMember(salon.salonId, "owner");
  });

  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
    if (owner) await cleanupTestUser(owner.userId);
    await cleanupAuthRateLimits();
    await cleanupRateLimitDelta();

    const { count, error } = await db
      .from("salons")
      .select("*", { count: "exact", head: true })
      .eq("slug", SLUG);
    if (error || count !== 0) {
      throw new Error(
        `request-load salon cleanup failed: ${error?.message ?? `${count} row(s)`}`,
      );
    }
    if (owner) {
      const { data, error: listUsersError } = await db.auth.admin.listUsers({
        page: 1,
        perPage: 1_000,
      });
      if (listUsersError) {
        throw new Error(
          `request-load auth cleanup verification failed: ${listUsersError.message}`,
        );
      }
      if (data.users.some((user) => user.id === owner!.userId)) {
        throw new Error("request-load auth user cleanup failed");
      }
    }
  });

  test(`${PUBLIC_REQUESTS} public-booking and ${DASHBOARD_REQUESTS} authenticated dashboard requests start together with zero failures`, async ({
    baseURL,
    browser,
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
    expect(owner).toBeDefined();
    if (MQA_ID === "MQA-0148") {
      expect([250, 500]).toContain(TOTAL_REQUESTS);
      expect(P95_SLA_MS).toBe(10_000);
      expect(MAX_SLA_MS).toBe(20_000);
      expect(process.env.NAILIQ_DISPOSABLE_DB).toBe("1");
    }

    const loginContext = await browser.newContext({ baseURL });
    const loginPage = await loginContext.newPage();
    const login = await loginAs(loginPage, owner!);
    const storageState = await loginContext.storageState();
    await loginPage.goto("about:blank");
    await loginContext.close();

    authRateLimitCleanupCandidates = authRateLimitBucketCandidates({
      email: owner!.email,
      ...login,
    });
    const authLimiterRows = await readRateLimitBuckets(
      authRateLimitCleanupCandidates,
    );
    authLimiterProof = {
      expectedDistinctRows: 6,
      observedDistinctRows: authLimiterRows.length,
      everyCountOne: authLimiterRows.every((row) => row.count === 1),
      cleanupVerified: false,
    };
    expect(authLimiterProof.observedDistinctRows).toBe(
      authLimiterProof.expectedDistinctRows,
    );
    expect(authLimiterProof.everyCountOne).toBe(true);
    await cleanupAuthRateLimits();
    authLimiterProof.cleanupVerified = true;

    const authPreflight = await playwrightRequest.newContext({
      baseURL,
      storageState,
    });
    const authResponse = await authPreflight.get(`/dashboard/${SLUG}`);
    const authBody = await authResponse.text();
    expect(authResponse.status()).toBe(200);
    expect(authResponse.url()).not.toMatch(/\/(?:login|register)(?:[/?#]|$)/);
    expect(authBody).toContain(SALON_NAME);
    await authPreflight.dispose();

    await prepareRateLimitBaseline();

    const requests = Array.from({ length: TOTAL_REQUESTS }, (_, index) => {
      const kind = index < PUBLIC_REQUESTS ? "booking" : "dashboard";
      return { index, kind } as const;
    });
    const contexts = await Promise.all(
      requests.map(({ index, kind }) =>
        playwrightRequest.newContext({
          baseURL,
          ...(kind === "dashboard" ? { storageState } : {}),
          extraHTTPHeaders: {
            accept: "text/html",
            "x-forwarded-for": testIp(`${SLUG}:${kind}:${index}`),
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
    const tasks = requests.map(async ({ index, kind }) => {
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
    loadFinishedAtMs = Date.now();
    const wallMs = Math.round(performance.now() - startedWallAt);
    await Promise.all(contexts.map((context) => context.dispose()));

    const allLimiterRows = await readAllBookingPageRateLimits();
    const limiterDelta = allLimiterRows
      .filter((row) => row.count !== rateLimitBaseline.get(row.bucket)?.count)
      .map((row) => ({
        bucket: row.bucket,
        countDelta: row.count - (rateLimitBaseline.get(row.bucket)?.count ?? 0),
      }));
    for (const row of limiterDelta) observedLoadBuckets.add(row.bucket);
    const expectedBucketCandidates = new Set(
      rateLimitBucketCandidates(loadStartedAtMs, loadFinishedAtMs),
    );
    const limiterProof = {
      expectedDistinctRows: PUBLIC_REQUESTS * 2,
      observedDistinctRows: limiterDelta.length,
      everyBucketExpected: limiterDelta.every((row) =>
        expectedBucketCandidates.has(row.bucket),
      ),
      everyCountDeltaOne: limiterDelta.every((row) => row.countDelta === 1),
      baselineRows: rateLimitBaseline.size,
    };

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
      appId: process.env.MQA_LOAD_EXPECTED_APP_ID?.trim() ?? null,
      sourceFingerprint:
        process.env.MQA_LOAD_EXPECTED_SOURCE_FINGERPRINT?.trim() ?? null,
      buildId: process.env.MQA_LOAD_EXPECTED_BUILD_ID?.trim() ?? null,
      documentRequests: {
        total: TOTAL_REQUESTS,
        publicBooking: PUBLIC_REQUESTS,
        dashboard: DASHBOARD_REQUESTS,
      },
      representativeHistoricalBookings: 250,
      startModel: `all ${TOTAL_REQUESTS} APIRequestContext document GETs released by one barrier`,
      authentication:
        "one seeded owner session reused by all authenticated dashboard requests",
      mutationModel:
        "no business-data mutation during requests; each public GET must write two durable limiter buckets",
      notMeasured:
        "browser JavaScript/assets/rendering, distinct human sessions, distributed source IPs, or hosted staging",
      thresholds: {
        failedRequests: 0,
        p95Ms: P95_SLA_MS,
        maxMs: MAX_SLA_MS,
      },
      wallMs,
      booking: summarize(bookingSamples),
      dashboard: summarize(dashboardSamples),
      overall: summarize(allSamples),
      authLimiterProof,
      limiterProof,
      failureCount: failures.length,
      failureSample: failures.slice(0, 10),
    };
    console.info(`[${MQA_ID}] ${JSON.stringify(result)}`);
    await testInfo.attach(`${MQA_ID.toLowerCase()}-${TOTAL_REQUESTS}-request-load.json`, {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });

    expect(failures, "every concurrent request must receive the correct tenant page").toEqual([]);
    expect(limiterProof.observedDistinctRows).toBe(
      limiterProof.expectedDistinctRows,
    );
    expect(limiterProof.everyBucketExpected).toBe(true);
    expect(limiterProof.everyCountDeltaOne).toBe(true);
    expect(result.booking.p95Ms, "public booking p95").toBeLessThan(P95_SLA_MS);
    expect(result.dashboard.p95Ms, "dashboard p95").toBeLessThan(P95_SLA_MS);
    expect(result.overall.p95Ms, "overall p95").toBeLessThan(P95_SLA_MS);
    expect(result.overall.maxMs, "overall max").toBeLessThan(MAX_SLA_MS);
  });
});
