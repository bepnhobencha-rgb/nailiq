import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { cleanupTestSalon, seedTestSalon } from "./helpers/db";

const MQA_ID = "MQA-0149";
const TOTAL_BOOKINGS = 1_000;
const SALON_COUNT = 28;
const STAFF_PER_SALON = 4;
const SLOTS_PER_STAFF = 9;
const CREATE_CONCURRENCY = 20;
const REPLAY_CONCURRENCY = 20;
const SLUG_PREFIX = "e2e-mqa-0149-daily-";
const CLIENT_PREFIX = "MQA149 Daily Load ";
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

type Fixture = {
  salonId: string;
  slug: string;
  serviceId: string;
  staffIds: string[];
};

type BookingMaterial = {
  index: number;
  salonId: string;
  serviceId: string;
  staffId: string;
  clientName: string;
  clientPhone: string;
  startTimeUtc: string;
  endTimeUtc: string;
  idempotencyKey: string;
  pricingFingerprint: string;
};

const fixtures: Fixture[] = [];
const syntheticPhones: string[] = [];

const ALWAYS_OPEN = {
  mon: { open: "00:00", close: "23:59", closed: false },
  tue: { open: "00:00", close: "23:59", closed: false },
  wed: { open: "00:00", close: "23:59", closed: false },
  thu: { open: "00:00", close: "23:59", closed: false },
  fri: { open: "00:00", close: "23:59", closed: false },
  sat: { open: "00:00", close: "23:59", closed: false },
  sun: { open: "00:00", close: "23:59", closed: false },
};

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

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(values[index]!, index);
      }
    }),
  );
  return results;
}

function rpcObject(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object"
    ? candidate as Record<string, unknown>
    : null;
}

async function cleanupAll() {
  for (const fixture of fixtures) {
    await cleanupTestSalon(fixture.slug);
  }
  for (let offset = 0; offset < syntheticPhones.length; offset += 100) {
    const { error } = await db
      .from("client_profiles")
      .delete()
      .in("phone", syntheticPhones.slice(offset, offset + 100));
    if (error) throw new Error(`cleanup synthetic profiles: ${error.message}`);
  }
}

async function seedFixtures() {
  for (let index = 0; index < SALON_COUNT; index += 1) {
    const suffix = String(index + 1).padStart(2, "0");
    const slug = `${SLUG_PREFIX}${suffix}`;
    const seeded = await seedTestSalon({
      slug,
      name: `E2E MQA-0149 Daily Salon ${suffix}`,
      phone: `1555340${String(index).padStart(4, "0")}`,
    });
    const { error: salonError } = await db
      .from("salons")
      .update({ timezone: "UTC", opening_hours: ALWAYS_OPEN })
      .eq("id", seeded.salonId);
    if (salonError) throw new Error(`configure ${slug}: ${salonError.message}`);

    const [{ data: services, error: serviceError }, { data: staff, error: staffError }] =
      await Promise.all([
        db.from("services").select("id").eq("salon_id", seeded.salonId),
        db.from("staff").select("id").eq("salon_id", seeded.salonId),
      ]);
    if (serviceError || !services?.[0]?.id) {
      throw new Error(`load service ${slug}: ${serviceError?.message ?? "missing"}`);
    }
    if (staffError || !staff?.[0]?.id) {
      throw new Error(`load staff ${slug}: ${staffError?.message ?? "missing"}`);
    }
    const serviceId = String(services[0].id);
    const initialStaffId = String(staff[0].id);
    const { data: addedStaff, error: addedStaffError } = await db
      .from("staff")
      .insert(
        Array.from({ length: STAFF_PER_SALON - 1 }, (_, staffIndex) => ({
          salon_id: seeded.salonId,
          name: `Daily Tech ${staffIndex + 2}`,
          job_role: "nail_tech",
        })),
      )
      .select("id");
    if (addedStaffError) throw new Error(`add staff ${slug}: ${addedStaffError.message}`);
    const staffIds = [initialStaffId, ...(addedStaff ?? []).map((row) => String(row.id))];
    const { error: capabilityError } = await db
      .from("staff_services")
      .insert(
        staffIds.slice(1).map((staff_id) => ({ staff_id, service_id: serviceId })),
      );
    if (capabilityError) {
      throw new Error(`add staff capabilities ${slug}: ${capabilityError.message}`);
    }
    fixtures.push({ salonId: seeded.salonId, slug, serviceId, staffIds });
  }
}

test.describe("MQA-0149 — 1000 bookings/day", () => {
  test.beforeAll(async () => {
    await seedFixtures();
  });

  test.afterAll(async () => {
    await cleanupAll();
  });

  test("replays a compressed platform day through canonical quote/create RPCs without duplicates", async ({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium",
      "The database-level daily profile is measured once",
    );
    test.setTimeout(12 * 60_000);

    const appointmentBaseMs = Date.now() + 48 * 60 * 60 * 1_000;
    const appointmentDayStart = new Date(appointmentBaseMs);
    appointmentDayStart.setUTCHours(8, 0, 0, 0);

    const rawMaterials: Omit<BookingMaterial, "pricingFingerprint">[] = [];
    for (const fixture of fixtures) {
      for (const staffId of fixture.staffIds) {
        for (let slot = 0; slot < SLOTS_PER_STAFF; slot += 1) {
          const index = rawMaterials.length;
          if (index >= TOTAL_BOOKINGS) break;
          const startMs = appointmentDayStart.getTime() + slot * 60 * 60 * 1_000;
          const clientPhone = `1604555${String(index).padStart(4, "0")}`;
          syntheticPhones.push(clientPhone);
          rawMaterials.push({
            index,
            salonId: fixture.salonId,
            serviceId: fixture.serviceId,
            staffId,
            clientName: `${CLIENT_PREFIX}${String(index + 1).padStart(4, "0")}`,
            clientPhone,
            startTimeUtc: new Date(startMs).toISOString(),
            endTimeUtc: new Date(startMs + 55 * 60 * 1_000).toISOString(),
            idempotencyKey: randomUUID(),
          });
        }
      }
    }
    expect(rawMaterials).toHaveLength(TOTAL_BOOKINGS);

    const quoteStartedAt = performance.now();
    const materials = await mapConcurrent(rawMaterials, CREATE_CONCURRENCY, async (material) => {
      const { data, error } = await db.rpc("quote_public_booking", {
        p_salon_id: material.salonId,
        p_service_id: material.serviceId,
        p_staff_id: material.staffId,
        p_start_time_utc: material.startTimeUtc,
        p_end_time_utc: material.endTimeUtc,
        p_addon_service_ids: [],
        p_combo_id: null,
        p_voucher_id: null,
        p_client_phone: material.clientPhone,
        p_client_email: null,
        p_apply_email_discount: false,
      });
      const quote = rpcObject(data);
      if (error || quote?.success !== true || typeof quote.pricing_fingerprint !== "string") {
        throw new Error(`quote ${material.index}: ${error?.message ?? JSON.stringify(quote)}`);
      }
      return { ...material, pricingFingerprint: quote.pricing_fingerprint };
    });
    const quoteWallMs = Math.round(performance.now() - quoteStartedAt);

    const createStartedAt = performance.now();
    const createResults = await mapConcurrent(materials, CREATE_CONCURRENCY, async (material) => {
      const startedAt = performance.now();
      const { data, error } = await db.rpc("create_public_booking", {
        p_salon_id: material.salonId,
        p_service_id: material.serviceId,
        p_staff_id: material.staffId,
        p_client_name: material.clientName,
        p_client_phone: material.clientPhone,
        p_start_time_utc: material.startTimeUtc,
        p_end_time_utc: material.endTimeUtc,
        p_status: "confirmed",
        p_client_notes: null,
        p_addon_service_ids: [],
        p_client_email: null,
        p_resource_id: null,
        p_combo_id: null,
        p_voucher_id: null,
        p_apply_email_discount: false,
        p_idempotency_key: material.idempotencyKey,
        p_expected_pricing_fingerprint: material.pricingFingerprint,
      });
      const receipt = rpcObject(data);
      if (error || receipt?.success !== true || typeof receipt.booking_id !== "string") {
        throw new Error(`create ${material.index}: ${error?.message ?? JSON.stringify(receipt)}`);
      }
      return {
        bookingId: receipt.booking_id,
        elapsedMs: Math.round(performance.now() - startedAt),
      };
    });
    const createWallMs = Math.round(performance.now() - createStartedAt);

    const salonIds = fixtures.map((fixture) => fixture.salonId);
    const { data: createdRows, count: createdCount, error: createdError } = await db
      .from("bookings")
      .select("id,idempotency_key,client_name,salon_id", { count: "exact" })
      .in("salon_id", salonIds)
      .like("client_name", `${CLIENT_PREFIX}%`)
      .limit(TOTAL_BOOKINGS + 10);
    expect(createdError).toBeNull();
    expect(createdCount).toBe(TOTAL_BOOKINGS);
    expect(new Set((createdRows ?? []).map((row) => row.id)).size).toBe(TOTAL_BOOKINGS);
    expect(new Set((createdRows ?? []).map((row) => row.idempotency_key)).size).toBe(TOTAL_BOOKINGS);

    const replayStartedAt = performance.now();
    const replayResults = await mapConcurrent(materials, REPLAY_CONCURRENCY, async (material, index) => {
      const startedAt = performance.now();
      const { data, error } = await db.rpc("create_public_booking", {
        p_salon_id: material.salonId,
        p_service_id: material.serviceId,
        p_staff_id: material.staffId,
        p_client_name: material.clientName,
        p_client_phone: material.clientPhone,
        p_start_time_utc: material.startTimeUtc,
        p_end_time_utc: material.endTimeUtc,
        p_status: "confirmed",
        p_client_notes: null,
        p_addon_service_ids: [],
        p_client_email: null,
        p_resource_id: null,
        p_combo_id: null,
        p_voucher_id: null,
        p_apply_email_discount: false,
        p_idempotency_key: material.idempotencyKey,
        p_expected_pricing_fingerprint: material.pricingFingerprint,
      });
      const receipt = rpcObject(data);
      if (
        error || receipt?.success !== true || receipt.idempotent !== true ||
        receipt.booking_id !== createResults[index]!.bookingId
      ) {
        throw new Error(`replay ${material.index}: ${error?.message ?? JSON.stringify(receipt)}`);
      }
      return Math.round(performance.now() - startedAt);
    });
    const replayWallMs = Math.round(performance.now() - replayStartedAt);

    const [{ count: afterReplayCount, error: replayCountError }, { count: queueDepth, error: queueError }] =
      await Promise.all([
        db.from("bookings").select("id", { count: "exact", head: true })
          .in("salon_id", salonIds).like("client_name", `${CLIENT_PREFIX}%`),
        db.from("booking_notifications").select("id", { count: "exact", head: true })
          .in("salon_id", salonIds),
      ]);
    expect(replayCountError).toBeNull();
    expect(queueError).toBeNull();
    expect(afterReplayCount).toBe(TOTAL_BOOKINGS);
    expect(queueDepth).toBe(0);

    const createSamples = createResults.map((result) => result.elapsedMs);
    const logicalBookingBytes = new TextEncoder().encode(JSON.stringify(createdRows)).byteLength;
    const result = {
      workload: {
        bookings: TOTAL_BOOKINGS,
        salons: SALON_COUNT,
        staffPerSalon: STAFF_PER_SALON,
        appointmentSlotsPerStaff: SLOTS_PER_STAFF,
        appointmentDayUtc: appointmentDayStart.toISOString().slice(0, 10),
        createConcurrency: CREATE_CONCURRENCY,
        replayConcurrency: REPLAY_CONCURRENCY,
      },
      boundary: "service-role canonical quote_public_booking plus create_public_booking RPC; no browser/provider side effects",
      quoteWallMs,
      createWallMs,
      createThroughputPerSecond: Number((TOTAL_BOOKINGS / (createWallMs / 1_000)).toFixed(2)),
      createLatency: summarize(createSamples),
      replayWallMs,
      replayThroughputPerSecond: Number((TOTAL_BOOKINGS / (replayWallMs / 1_000)).toFixed(2)),
      replayLatency: summarize(replayResults),
      committedRows: createdCount,
      uniqueBookingIds: new Set(createResults.map((result) => result.bookingId)).size,
      uniqueIdempotencyKeys: new Set((createdRows ?? []).map((row) => row.idempotency_key)).size,
      rowsAfterFullReplay: afterReplayCount,
      duplicateRows: Number(afterReplayCount) - TOTAL_BOOKINGS,
      providerQueueDepth: queueDepth,
      logicalSelectedBookingBytes: logicalBookingBytes,
    };
    console.info(`[${MQA_ID}] ${JSON.stringify(result)}`);
    await testInfo.attach("mqa-0149-thousand-bookings-daily-profile.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });

    expect(result.committedRows).toBe(TOTAL_BOOKINGS);
    expect(result.uniqueBookingIds).toBe(TOTAL_BOOKINGS);
    expect(result.uniqueIdempotencyKeys).toBe(TOTAL_BOOKINGS);
    expect(result.duplicateRows).toBe(0);
    expect(result.providerQueueDepth).toBe(0);
  });
});
