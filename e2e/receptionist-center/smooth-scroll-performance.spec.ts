import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import {
  expect,
  test,
  type CDPSession,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

import { cleanupTestSalon, cleanupTestUser, seedTestSalonMember } from "../helpers/db";
import {
  MQA_0032_SURFACES,
  analyzeMqa0032ScrollTrace,
  type Mqa0032Axis,
  type Mqa0032RuntimeMeasurement,
  type Mqa0032Surface,
  type Mqa0032TraceAnalysis,
} from "../helpers/mqaScrollTrace";
import {
  gotoReceptionistCenter,
  isoAtUtcYmdHourMinute,
  seedDeskBooking,
  seedReceptionistCenterFixture,
  seedWalkin,
  supabaseAdmin,
  type ReceptionistCenterFixture,
} from "./helpers";

const MQA_ID = "MQA-0032";
const SLUG = "e2e-mqa-0032-scroll";
const LOCAL_APP_URL = "http://127.0.0.1:3100";
const LOCAL_SUPABASE_URL = "http://127.0.0.1:54321";
const WHEEL_EVENTS_PER_DIRECTION = 24;
const WHEEL_STEP_DELAY_MS = 16;

type TraceIdentity = {
  mqaId: typeof MQA_ID;
  sourceFingerprint: string;
  buildId: string;
  appId: string;
  appUrl: typeof LOCAL_APP_URL;
  supabaseUrl: typeof LOCAL_SUPABASE_URL;
  serverMode: "production-build";
};

type BrowserScrollProbe = {
  axis: Mqa0032Axis;
  trustedWheelEvents: number;
  scrollEvents: number;
  lastPositionPx: number;
  minPositionPx: number;
  maxPositionPx: number;
  totalTravelPx: number;
  onWheel: (event: WheelEvent) => void;
  onScroll: () => void;
};

type ProbedElement = HTMLElement & {
  __mqa0032ScrollProbe?: BrowserScrollProbe;
};

type TraceCaptureResult = {
  rawTrace: {
    traceEvents: unknown[];
    metadata: { mqa0032: TraceIdentity };
  };
  runtimeMeasurements: Mqa0032RuntimeMeasurement[];
  error: string | null;
};

type CleanupResult = {
  result: "PASS" | "FAIL";
  slug: string;
  salonId: string | null;
  userId: string | null;
  remaining: {
    salonsBySlug: number | null;
    salonsById: number | null;
    bookings: number | null;
    staff: number | null;
    services: number | null;
    salonMembers: number | null;
    authUserPresent: boolean | null;
  };
  errors: string[];
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required by ${MQA_ID}`);
  return value;
}

function exactLocalIdentity(): TraceIdentity {
  const sourceFingerprint = requiredEnvironment(
    "MQA_SCROLL_EXPECTED_SOURCE_FINGERPRINT",
  );
  const buildId = requiredEnvironment("MQA_SCROLL_EXPECTED_BUILD_ID");
  const appId = requiredEnvironment("MQA_SCROLL_EXPECTED_APP_ID");
  const expectedAppId = `mqa-local-${sourceFingerprint.slice(0, 12)}-${buildId}`;

  if (
    process.env.MQA_SCROLL_RUN_ID !== MQA_ID ||
    process.env.MQA_SCROLL_SERVER_MODE !== "production-build" ||
    process.env.NAILIQ_DISPOSABLE_DB !== "1" ||
    process.env.PLAYWRIGHT_BASE_URL?.replace(/\/$/, "") !== LOCAL_APP_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "") !==
      LOCAL_SUPABASE_URL ||
    process.env.SUPABASE_INTERNAL_URL?.replace(/\/$/, "") !==
      LOCAL_SUPABASE_URL ||
    process.env.VERCEL_DEPLOYMENT_ID !== appId ||
    !/^[a-f0-9]{64}$/.test(sourceFingerprint) ||
    !/^[A-Za-z0-9_-]+$/.test(buildId) ||
    appId !== expectedAppId
  ) {
    throw new Error(
      `${MQA_ID} requires the pinned fresh production build at ${LOCAL_APP_URL} ` +
        `and the exclusive disposable Supabase stack at ${LOCAL_SUPABASE_URL}`,
    );
  }

  return {
    mqaId: MQA_ID,
    sourceFingerprint,
    buildId,
    appId,
    appUrl: LOCAL_APP_URL,
    supabaseUrl: LOCAL_SUPABASE_URL,
    serverMode: "production-build",
  };
}

// Evaluate the local identity before Playwright can seed a row. The dedicated
// config repeats these checks and additionally fingerprints the files on disk.
const TRACE_IDENTITY = exactLocalIdentity();

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeErrors(...errors: Array<unknown | null>): string | null {
  const messages = errors
    .filter((error): error is unknown => error !== null)
    .map(safeError);
  return messages.length > 0 ? messages.join(" | ") : null;
}

async function loginAsOwner(
  page: Page,
  owner: { email: string; password: string },
): Promise<void> {
  const digest = createHash("sha256").update(owner.email).digest("hex");
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `2001:db8::${digest.slice(0, 4)}:${digest.slice(4, 8)}`,
  });
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute(
    "data-hydrated",
    "true",
  );
  await page.locator('input[inputmode="email"]').fill(owner.email);
  await page.locator('input[type="password"]').fill(owner.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(new RegExp(`/dashboard/${SLUG}(?:[/?]|$)`), {
    timeout: 30_000,
  });
}

async function seedScrollWorkload(
  fixture: ReceptionistCenterFixture,
): Promise<void> {
  const hoursByStaff = [
    [8, 12, 14, 16, 18],
    [8, 10, 12, 14, 16],
    [10, 12, 14, 16, 18],
    [8, 10, 14, 16, 18],
    [8, 10, 12, 17, 18],
  ] as const;
  const serviceId = fixture.serviceIds[1]!;

  for (let staffIndex = 0; staffIndex < hoursByStaff.length; staffIndex += 1) {
    for (const hour of hoursByStaff[staffIndex]!) {
      await seedDeskBooking(fixture.salonId, {
        clientName: `Te2eGuestMqa0032Desk${staffIndex}${hour}`,
        serviceId,
        staffId: fixture.staffIds[staffIndex]!,
        startIso: isoAtUtcYmdHourMinute(fixture.ymdUtc, hour, 0),
        endIso: isoAtUtcYmdHourMinute(fixture.ymdUtc, hour, 30),
        status: "confirmed",
      });
    }
  }

  const now = Date.now();
  for (let index = 0; index < 24; index += 1) {
    await seedWalkin(fixture.salonId, {
      clientName: `Te2eGuestMqa0032Queue${String(index + 1).padStart(2, "0")}`,
      serviceId,
      joinedQueueAtIso: new Date(now - (index + 1) * 60_000).toISOString(),
    });
  }
}

async function installScrollProbe(
  locator: Locator,
  axis: Mqa0032Axis,
): Promise<void> {
  await locator.evaluate((node, probeAxis) => {
    const element = node as ProbedElement;
    element.scrollTo({ left: 0, top: 0, behavior: "auto" });
    const initialPosition =
      probeAxis === "horizontal" ? element.scrollLeft : element.scrollTop;
    const probe: BrowserScrollProbe = {
      axis: probeAxis,
      trustedWheelEvents: 0,
      scrollEvents: 0,
      lastPositionPx: initialPosition,
      minPositionPx: initialPosition,
      maxPositionPx: initialPosition,
      totalTravelPx: 0,
      onWheel: () => {},
      onScroll: () => {},
    };
    probe.onWheel = (event: WheelEvent) => {
      if (event.isTrusted) probe.trustedWheelEvents += 1;
    };
    probe.onScroll = () => {
      const next =
        probe.axis === "horizontal" ? element.scrollLeft : element.scrollTop;
      probe.scrollEvents += 1;
      probe.totalTravelPx += Math.abs(next - probe.lastPositionPx);
      probe.lastPositionPx = next;
      probe.minPositionPx = Math.min(probe.minPositionPx, next);
      probe.maxPositionPx = Math.max(probe.maxPositionPx, next);
    };
    element.__mqa0032ScrollProbe = probe;
    element.addEventListener("wheel", probe.onWheel, { passive: true });
    element.addEventListener("scroll", probe.onScroll, { passive: true });
  }, axis);
}

async function readAndRemoveScrollProbe(
  locator: Locator,
  surface: Mqa0032Surface,
  dispatchedWheelEvents: number,
): Promise<Mqa0032RuntimeMeasurement> {
  return locator.evaluate(
    (node, input) => {
      const element = node as ProbedElement;
      const probe = element.__mqa0032ScrollProbe;
      if (!probe) throw new Error(`${input.surface}: scroll probe is missing`);
      const finalPositionPx =
        probe.axis === "horizontal" ? element.scrollLeft : element.scrollTop;
      const maxReachablePx =
        probe.axis === "horizontal"
          ? element.scrollWidth - element.clientWidth
          : element.scrollHeight - element.clientHeight;
      element.removeEventListener("wheel", probe.onWheel);
      element.removeEventListener("scroll", probe.onScroll);
      delete element.__mqa0032ScrollProbe;
      return {
        surface: input.surface,
        axis: probe.axis,
        sweeps: 3,
        dispatchedWheelEvents: input.dispatchedWheelEvents,
        trustedWheelEvents: probe.trustedWheelEvents,
        scrollEvents: probe.scrollEvents,
        maxReachablePx,
        totalTravelPx: probe.totalTravelPx,
        minPositionPx: probe.minPositionPx,
        maxPositionPx: probe.maxPositionPx,
        finalPositionPx,
      };
    },
    { surface, dispatchedWheelEvents },
  );
}

async function timestamp(page: Page, marker: string): Promise<void> {
  await page.evaluate((message) => console.timeStamp(message), marker);
}

async function measureSurface(
  page: Page,
  locator: Locator,
  surface: Mqa0032Surface,
  axis: Mqa0032Axis,
): Promise<Mqa0032RuntimeMeasurement> {
  await expect(locator).toBeVisible();
  await installScrollProbe(locator, axis);
  await page.waitForTimeout(100);

  const box = await locator.boundingBox();
  if (!box || box.width < 40 || box.height < 40) {
    throw new Error(`${surface}: scroll target has no usable bounding box`);
  }
  const pointer =
    axis === "vertical"
      ? { x: box.x + box.width - 24, y: box.y + box.height / 2 }
      : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(pointer.x, pointer.y);
  await timestamp(page, `mqa-0032:${surface}:begin`);

  let dispatchedWheelEvents = 0;
  const step = axis === "horizontal" ? 32 : 64;
  for (let sweep = 0; sweep < 3; sweep += 1) {
    for (const direction of [1, -1] as const) {
      for (let index = 0; index < WHEEL_EVENTS_PER_DIRECTION; index += 1) {
        await page.mouse.wheel(
          axis === "horizontal" ? direction * step : 0,
          axis === "vertical" ? direction * step : 0,
        );
        dispatchedWheelEvents += 1;
        await page.waitForTimeout(WHEEL_STEP_DELAY_MS);
      }
    }
  }

  await page.waitForTimeout(150);
  await timestamp(page, `mqa-0032:${surface}:end`);
  return readAndRemoveScrollProbe(locator, surface, dispatchedWheelEvents);
}

function traceCompletion(session: CDPSession): Promise<void> {
  return new Promise((resolve) => {
    session.once("Tracing.tracingComplete", () => resolve());
  });
}

async function waitForTraceCompletion(
  completion: Promise<void>,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      completion,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Tracing.tracingComplete timed out after 30s")),
          30_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function captureScrollTrace(page: Page): Promise<TraceCaptureResult> {
  const session = await page.context().newCDPSession(page);
  const traceEvents: unknown[] = [];
  const runtimeMeasurements: Mqa0032RuntimeMeasurement[] = [];
  const completion = traceCompletion(session);
  let tracingStarted = false;
  let actionError: unknown | null = null;
  let stopError: unknown | null = null;

  session.on(
    "Tracing.dataCollected",
    (payload: { value?: unknown[] }) => {
      if (Array.isArray(payload.value)) traceEvents.push(...payload.value);
    },
  );

  try {
    await session.send("Tracing.start", {
      categories: [
        "__metadata",
        "benchmark",
        "blink.console",
        "cc",
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
        "disabled-by-default-devtools.timeline.frame",
        "input",
        "input.scrolling",
        "latencyInfo",
        "toplevel",
      ].join(","),
      options: "record-as-much-as-possible",
      transferMode: "ReportEvents",
    });
    tracingStarted = true;

    try {
      runtimeMeasurements.push(
        await measureSurface(
          page,
          page.getByTestId("staff-timeline-grid").first(),
          "timeline",
          "horizontal",
        ),
      );
      runtimeMeasurements.push(
        await measureSurface(
          page,
          page.getByTestId("walkin-queue-scroll").first(),
          "queue",
          "vertical",
        ),
      );
    } catch (error) {
      actionError = error;
    }
  } catch (error) {
    actionError = error;
  } finally {
    if (tracingStarted) {
      try {
        await session.send("Tracing.end");
        await waitForTraceCompletion(completion);
      } catch (error) {
        stopError = error;
      }
    }
    try {
      await session.detach();
    } catch (error) {
      stopError = mergeErrors(stopError, error);
    }
  }

  return {
    rawTrace: {
      traceEvents,
      metadata: { mqa0032: TRACE_IDENTITY },
    },
    runtimeMeasurements,
    error: mergeErrors(actionError, stopError),
  };
}

async function attachJson(
  testInfo: TestInfo,
  name: string,
  value: unknown,
): Promise<void> {
  await testInfo.attach(name, {
    body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
    contentType: "application/json",
  });
}

async function cleanupAndVerify(input: {
  slug: string;
  salonId: string | null;
  userId: string | null;
}): Promise<CleanupResult> {
  const errors: string[] = [];
  try {
    await cleanupTestSalon(input.slug);
  } catch (error) {
    errors.push(`cleanupTestSalon: ${safeError(error)}`);
  }
  if (input.userId) {
    try {
      await cleanupTestUser(input.userId);
    } catch (error) {
      errors.push(`cleanupTestUser: ${safeError(error)}`);
    }
  }

  const remaining: CleanupResult["remaining"] = {
    salonsBySlug: null,
    salonsById: null,
    bookings: null,
    staff: null,
    services: null,
    salonMembers: null,
    authUserPresent: null,
  };
  const queries = [
    supabaseAdmin
      .from("salons")
      .select("*", { count: "exact", head: true })
      .eq("slug", input.slug),
    input.salonId
      ? supabaseAdmin
          .from("salons")
          .select("*", { count: "exact", head: true })
          .eq("id", input.salonId)
      : Promise.resolve({ count: 0, error: null }),
    input.salonId
      ? supabaseAdmin
          .from("bookings")
          .select("*", { count: "exact", head: true })
          .eq("salon_id", input.salonId)
      : Promise.resolve({ count: 0, error: null }),
    input.salonId
      ? supabaseAdmin
          .from("staff")
          .select("*", { count: "exact", head: true })
          .eq("salon_id", input.salonId)
      : Promise.resolve({ count: 0, error: null }),
    input.salonId
      ? supabaseAdmin
          .from("services")
          .select("*", { count: "exact", head: true })
          .eq("salon_id", input.salonId)
      : Promise.resolve({ count: 0, error: null }),
    input.salonId
      ? supabaseAdmin
          .from("salon_members")
          .select("*", { count: "exact", head: true })
          .eq("salon_id", input.salonId)
      : Promise.resolve({ count: 0, error: null }),
  ];

  try {
    const [slugRows, salonRows, bookingRows, staffRows, serviceRows, memberRows] =
      await Promise.all(queries);
    const results = [
      ["salonsBySlug", slugRows],
      ["salonsById", salonRows],
      ["bookings", bookingRows],
      ["staff", staffRows],
      ["services", serviceRows],
      ["salonMembers", memberRows],
    ] as const;
    for (const [label, result] of results) {
      if (result.error) errors.push(`${label}: ${result.error.message}`);
      remaining[label] = result.count ?? null;
    }
  } catch (error) {
    errors.push(`cleanup verification query: ${safeError(error)}`);
  }

  if (input.userId) {
    try {
      const { data, error } = await supabaseAdmin.auth.admin.getUserById(
        input.userId,
      );
      remaining.authUserPresent = Boolean(data.user);
      if (error && !/not found|user_not_found/i.test(error.message)) {
        errors.push(`auth cleanup verification: ${error.message}`);
      }
    } catch (error) {
      // The local Auth API reports a not-found response after successful delete.
      remaining.authUserPresent = false;
      if (!/not found|user_not_found/i.test(safeError(error))) {
        errors.push(`auth cleanup verification: ${safeError(error)}`);
      }
    }
  } else {
    remaining.authUserPresent = false;
  }

  const countsAreZero = Object.entries(remaining).every(([key, value]) =>
    key === "authUserPresent" ? value === false : value === 0,
  );
  return {
    result: errors.length === 0 && countsAreZero ? "PASS" : "FAIL",
    slug: input.slug,
    salonId: input.salonId,
    userId: input.userId,
    remaining,
    errors,
  };
}

test.describe(`${MQA_ID} — compositor-backed smooth scrolling`, () => {
  test("timeline and walk-in queue pass three real wheel sweeps", async ({ page }, testInfo) => {
    test.setTimeout(6 * 60_000);

    let fixture: ReceptionistCenterFixture | undefined;
    let owner: Awaited<ReturnType<typeof seedTestSalonMember>> | undefined;
    let analysis: Mqa0032TraceAnalysis | undefined;
    let executionError: unknown | null = null;
    let cleanupResult: CleanupResult | undefined;

    try {
      fixture = await seedReceptionistCenterFixture(SLUG);
      await seedScrollWorkload(fixture);
      owner = await seedTestSalonMember(fixture.salonId, "owner");
      await loginAsOwner(page, owner);
      await gotoReceptionistCenter(page, fixture.slug, {
        dateYmd: fixture.ymdUtc,
        expectWalkinQueue: true,
        shellV2: true,
        useDemoCookie: false,
      });
      await page.waitForTimeout(350);

      const capture = await captureScrollTrace(page);
      await testInfo.attach("mqa-0032-scroll-trace.json.gz", {
        body: gzipSync(Buffer.from(JSON.stringify(capture.rawTrace), "utf8")),
        contentType: "application/gzip",
      });
      analysis = analyzeMqa0032ScrollTrace({
        rawTrace: capture.rawTrace,
        runtimeMeasurements: capture.runtimeMeasurements,
      });
      await attachJson(testInfo, "mqa-0032-scroll-analysis.json", {
        identity: TRACE_IDENTITY,
        captureError: capture.error,
        analysis,
      });

      if (capture.error) {
        throw new Error(`trace capture failed: ${capture.error}`);
      }
      if (analysis.result !== "PASS") {
        throw new Error(
          `${MQA_ID} trace gate failed: ${analysis.failures.join(" | ")}`,
        );
      }
    } catch (error) {
      executionError = error;
    } finally {
      cleanupResult = await cleanupAndVerify({
        slug: SLUG,
        salonId: fixture?.salonId ?? null,
        userId: owner?.userId ?? null,
      });
      await attachJson(testInfo, "mqa-0032-cleanup.json", cleanupResult);
    }

    if (cleanupResult?.result !== "PASS") {
      throw new Error(
        mergeErrors(
          executionError,
          `MQA-0032 cleanup failed: ${cleanupResult?.errors.join(" | ") ?? "unknown"}; ` +
            `remaining=${JSON.stringify(cleanupResult?.remaining ?? {})}`,
        ) ?? "MQA-0032 cleanup failed",
      );
    }
    if (executionError) throw executionError;

    expect(analysis?.result).toBe("PASS");
    expect(analysis?.failures).toEqual([]);
    for (const surface of MQA_0032_SURFACES) {
      expect(analysis?.runtime[surface].sweeps).toBe(3);
    }
  });
});
