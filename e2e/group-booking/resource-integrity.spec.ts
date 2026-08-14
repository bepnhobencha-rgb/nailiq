import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { salonDateOffset, salonWallTimeToUtcIso } from "@/shared/lib/salonTime";

import {
  cleanupTestSalon,
  cleanupTestUser,
  seedTestSalonMember,
} from "../helpers/db";
import { seedGroupTestSalon } from "./helpers";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
if (!supabaseUrl || !serviceKey || !anonKey) {
  throw new Error(
    "group resource integrity requires the guarded throwaway Supabase environment",
  );
}

const db = createClient(supabaseUrl, serviceKey);
const publicDb = createClient(supabaseUrl, anonKey);
const TIMEZONE = "America/Vancouver";
const SLUG = "e2e-group-resource-integrity";
const FOREIGN_SLUG = "e2e-group-resource-integrity-foreign";
const BLOCK_MINUTES = 55;
let phoneBatch = 0;

type RpcResult = {
  success?: boolean;
  code?: string;
  group_id?: string;
  booking_ids?: string[];
};

function dayOfWeek(dateYmd: string): number {
  const [year, month, day] = dateYmd.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function nextOpenDateYmd(minimumDaysAhead = 3): string {
  for (
    let offset = minimumDaysAhead;
    offset < minimumDaysAhead + 7;
    offset += 1
  ) {
    const candidate = salonDateOffset(TIMEZONE, offset);
    if (dayOfWeek(candidate) !== 0) return candidate;
  }
  throw new Error("resource integrity fixture could not find an open day");
}

type GroupPayloadMember = {
  salon_id: string;
  staff_id: string;
  service_id: string;
  client_name: string;
  client_phone: string;
  client_email: null;
  client_notes: null;
  start_time_utc: string;
  end_time_utc: string;
  addon_service_ids: string[];
  wave_number: number;
  seat_together: boolean;
  staff_requested_by_client: boolean;
  idempotency_key: string;
  client_locale: string;
};

function payloadFor(input: {
  salonId: string;
  serviceId: string;
  staffIds: string[];
  startIso: string;
  marker: string;
}): GroupPayloadMember[] {
  const batch = phoneBatch++;
  const idempotencyKey = randomUUID();
  const endIso = new Date(
    Date.parse(input.startIso) + BLOCK_MINUTES * 60_000,
  ).toISOString();

  return input.staffIds.map((staffId, index) => ({
    salon_id: input.salonId,
    staff_id: staffId,
    service_id: input.serviceId,
    client_name: `${input.marker}-${index + 1}`,
    client_phone: `1604555${String(batch * 20 + index + 1).padStart(4, "0")}`,
    client_email: null,
    client_notes: null,
    start_time_utc: input.startIso,
    end_time_utc: endIso,
    addon_service_ids: [],
    wave_number: 1,
    seat_together: true,
    staff_requested_by_client: true,
    // Match submitGroupBooking: one group-level UUID is stamped on every row.
    idempotency_key: idempotencyKey,
    client_locale: "en",
  }));
}

type GroupPayload = GroupPayloadMember[];

async function invokePrivateGroupBoundary(p_bookings: GroupPayload) {
  const { data, error } = await db.rpc(
    "insert_group_bookings_unlimited" as never,
    { p_bookings } as never,
  );
  expect(error).toBeNull();
  return data as RpcResult;
}

async function expectNoRowsForMarker(marker: string) {
  const { count, error } = await db
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .like("client_name", `${marker}%`);
  expect(error).toBeNull();
  expect(count).toBe(0);
}

test.describe.serial("Group booking resource integrity", () => {
  let salonId = "";
  let serviceId = "";
  let staffIds: string[] = [];
  let resourceIds: string[] = [];
  let foreignSalonId = "";
  let foreignServiceId = "";
  let foreignStaffId = "";
  let ownerUserId = "";
  const dateYmd = nextOpenDateYmd();

  test.beforeAll(async () => {
    const seeded = await seedGroupTestSalon(SLUG);
    salonId = seeded.salonId;
    serviceId = seeded.serviceIds[0] ?? "";

    const { data: fourthStaff, error: fourthStaffError } = await db
      .from("staff")
      .insert({
        salon_id: salonId,
        name: "Resource Integrity Tech",
        job_role: "nail_tech",
      })
      .select("id")
      .single();
    if (fourthStaffError || !fourthStaff?.id || !serviceId) {
      throw new Error(
        fourthStaffError?.message ?? "resource integrity fixture is incomplete",
      );
    }
    staffIds = [...seeded.staffIds, String(fourthStaff.id)];

    const foreign = await seedGroupTestSalon(FOREIGN_SLUG);
    foreignSalonId = foreign.salonId;
    foreignServiceId = foreign.serviceIds[0] ?? "";
    foreignStaffId = foreign.staffIds[0] ?? "";
    if (!foreignServiceId || !foreignStaffId) {
      throw new Error("foreign tenant fixture is incomplete");
    }

    const { error: capabilityError } = await db.from("staff_services").insert({
      staff_id: fourthStaff.id,
      service_id: serviceId,
    });
    if (capabilityError) throw new Error(capabilityError.message);

    const { error: salonError } = await db
      .from("salons")
      .update({ resources_enabled: true, timezone: TIMEZONE })
      .eq("id", salonId);
    if (salonError) throw new Error(salonError.message);

    const { data: resources, error: resourcesError } = await db
      .from("salon_resources")
      .insert([
        {
          salon_id: salonId,
          name: "Integrity Chair 1",
          kind: "chair",
          display_order: 1,
          status: "active",
        },
        {
          salon_id: salonId,
          name: "Integrity Chair 2",
          kind: "chair",
          display_order: 2,
          status: "active",
        },
      ])
      .select("id");
    if (resourcesError || resources?.length !== 2) {
      throw new Error(
        resourcesError?.message ?? "resource integrity chairs were not created",
      );
    }
    resourceIds = resources.map((resource) => String(resource.id));

    const owner = await seedTestSalonMember(salonId, "owner");
    ownerUserId = owner.userId;
  });

  test.beforeEach(async () => {
    await db
      .from("bookings")
      .delete()
      .in("salon_id", [salonId, foreignSalonId]);
    const { error } = await db
      .from("salons")
      .update({ resources_enabled: true })
      .eq("id", salonId);
    if (error) throw new Error(error.message);
  });

  test.afterAll(async () => {
    if (salonId) {
      await db.from("bookings").delete().eq("salon_id", salonId);
      await db.from("salon_resources").delete().eq("salon_id", salonId);
    }
    await cleanupTestSalon(SLUG);
    await cleanupTestSalon(FOREIGN_SLUG);
    if (ownerUserId) await cleanupTestUser(ownerUserId);
  });

  test("rejects a mixed-salon payload before any group row is written", async () => {
    const startIso = salonWallTimeToUtcIso(dateYmd, 9 * 60, TIMEZONE);
    const marker = `MixedTenant-${randomUUID()}`;
    const local = payloadFor({
      salonId,
      serviceId,
      staffIds: staffIds.slice(0, 1),
      startIso,
      marker,
    });
    const foreign = payloadFor({
      salonId: foreignSalonId,
      serviceId: foreignServiceId,
      staffIds: [foreignStaffId],
      startIso,
      marker,
    });

    await expect(
      invokePrivateGroupBoundary([local[0], foreign[0]]),
    ).resolves.toMatchObject({ success: false, code: "invalid_salon" });
    await expectNoRowsForMarker(marker);
  });

  test("rejects a foreign-tenant staff reference before writing", async () => {
    const startIso = salonWallTimeToUtcIso(dateYmd, 9 * 60, TIMEZONE);
    const marker = `ForeignStaff-${randomUUID()}`;
    const payload = payloadFor({
      salonId,
      serviceId,
      staffIds: staffIds.slice(0, 2),
      startIso,
      marker,
    });
    payload[1] = { ...payload[1], staff_id: foreignStaffId };

    await expect(invokePrivateGroupBoundary(payload)).resolves.toMatchObject({
      success: false,
      code: "invalid_staff",
    });
    await expectNoRowsForMarker(marker);
  });

  test("rejects a foreign-tenant service reference before writing", async () => {
    const startIso = salonWallTimeToUtcIso(dateYmd, 9 * 60, TIMEZONE);
    const marker = `ForeignService-${randomUUID()}`;
    const payload = payloadFor({
      salonId,
      serviceId,
      staffIds: staffIds.slice(0, 2),
      startIso,
      marker,
    });
    payload[1] = { ...payload[1], service_id: foreignServiceId };

    await expect(invokePrivateGroupBoundary(payload)).resolves.toMatchObject({
      success: false,
      code: "invalid_service",
    });
    await expectNoRowsForMarker(marker);
  });

  test("rejects an active staff-service pair missing from a configured capability whitelist", async () => {
    const startIso = salonWallTimeToUtcIso(dateYmd, 9 * 60, TIMEZONE);
    const marker = `MissingCapability-${randomUUID()}`;
    const restrictedStaffId = staffIds[1];
    if (!restrictedStaffId) throw new Error("capability fixture is incomplete");

    const { error: removeError } = await db
      .from("staff_services")
      .delete()
      .eq("staff_id", restrictedStaffId)
      .eq("service_id", serviceId);
    if (removeError) throw new Error(removeError.message);

    try {
      const payload = payloadFor({
        salonId,
        serviceId,
        staffIds: [staffIds[0] ?? "", restrictedStaffId],
        startIso,
        marker,
      });

      await expect(invokePrivateGroupBoundary(payload)).resolves.toMatchObject({
        success: false,
        code: "invalid_staff",
      });
      await expectNoRowsForMarker(marker);
    } finally {
      const { error: restoreError } = await db.from("staff_services").insert({
        staff_id: restrictedStaffId,
        service_id: serviceId,
      });
      if (restoreError) throw new Error(restoreError.message);
    }
  });

  test("rejects invalid member time before writing", async () => {
    const startIso = salonWallTimeToUtcIso(dateYmd, 9 * 60, TIMEZONE);
    const marker = `InvalidTime-${randomUUID()}`;
    const payload = payloadFor({
      salonId,
      serviceId,
      staffIds: staffIds.slice(0, 2),
      startIso,
      marker,
    });
    payload[1] = { ...payload[1], end_time_utc: startIso };

    await expect(invokePrivateGroupBoundary(payload)).resolves.toMatchObject({
      success: false,
      code: "invalid_booking_time",
    });
    await expectNoRowsForMarker(marker);
  });

  test("rejects a malformed idempotency key before writing", async () => {
    const startIso = salonWallTimeToUtcIso(dateYmd, 9 * 60, TIMEZONE);
    const malformedMarker = `MalformedIdempotency-${randomUUID()}`;
    const malformed = payloadFor({
      salonId,
      serviceId,
      staffIds: staffIds.slice(0, 2),
      startIso,
      marker: malformedMarker,
    });
    malformed[1] = { ...malformed[1], idempotency_key: "not-a-uuid" };

    await expect(invokePrivateGroupBoundary(malformed)).resolves.toMatchObject({
      success: false,
      code: "invalid_booking_data",
    });
    await expectNoRowsForMarker(malformedMarker);
  });

  test("rejects an oversized party atomically when chairs run out", async () => {
    const startIso = salonWallTimeToUtcIso(dateYmd, 10 * 60, TIMEZONE);
    const marker = `ResourceAtomic-${randomUUID()}`;
    const { data, error } = await publicDb.rpc("insert_group_bookings", {
      p_bookings: payloadFor({
        salonId,
        serviceId,
        staffIds: staffIds.slice(0, 3),
        startIso,
        marker,
      }),
    });

    expect(error).toBeNull();
    expect(data as RpcResult).toMatchObject({
      success: false,
      code: "slot_conflict",
    });

    const { count } = await db
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("salon_id", salonId)
      .like("client_name", `${marker}%`);
    expect(count).toBe(0);
  });

  test("serializes concurrent groups on chair capacity without a staff conflict", async () => {
    const startIso = salonWallTimeToUtcIso(dateYmd, 13 * 60, TIMEZONE);
    const marker = `ResourceRace-${randomUUID()}`;
    const [left, right] = await Promise.all([
      publicDb.rpc("insert_group_bookings", {
        p_bookings: payloadFor({
          salonId,
          serviceId,
          staffIds: staffIds.slice(0, 2),
          startIso,
          marker: `${marker}-A`,
        }),
      }),
      publicDb.rpc("insert_group_bookings", {
        p_bookings: payloadFor({
          salonId,
          serviceId,
          staffIds: staffIds.slice(2, 4),
          startIso,
          marker: `${marker}-B`,
        }),
      }),
    ]);

    expect(left.error).toBeNull();
    expect(right.error).toBeNull();
    const outcomes = [left.data as RpcResult, right.data as RpcResult];
    expect(outcomes.filter((outcome) => outcome.success === true)).toHaveLength(
      1,
    );
    expect(
      outcomes.filter(
        (outcome) =>
          outcome.success === false && outcome.code === "slot_conflict",
      ),
    ).toHaveLength(1);

    const { data: rows, error: rowsError } = await db
      .from("bookings")
      .select("staff_id, resource_id")
      .eq("salon_id", salonId)
      .like("client_name", `${marker}%`);
    expect(rowsError).toBeNull();
    expect(rows).toHaveLength(2);
    expect(new Set(rows?.map((row) => row.staff_id)).size).toBe(2);
    expect(new Set(rows?.map((row) => row.resource_id))).toEqual(
      new Set(resourceIds),
    );
  });

  test("assigns chairs through the controlled after-hours group boundary", async () => {
    const startIso = salonWallTimeToUtcIso(dateYmd, 18 * 60, TIMEZONE);
    const marker = `ControlledAfterHours-${randomUUID()}`;
    const p_bookings = payloadFor({
      salonId,
      serviceId,
      staffIds: staffIds.slice(0, 2),
      startIso,
      marker,
    }).map((booking) => ({ ...booking, after_hours_minutes: 55 }));

    const { data, error } = await db.rpc(
      "insert_controlled_after_hours_group_bookings" as never,
      { p_bookings, p_actor_user_id: ownerUserId } as never,
    );
    expect(error).toBeNull();
    expect(data as RpcResult).toMatchObject({ success: true });

    const { data: rows, error: rowsError } = await db
      .from("bookings")
      .select(
        "resource_id, after_hours_minutes, after_hours_approved_by, after_hours_staff_consent",
      )
      .eq("salon_id", salonId)
      .like("client_name", `${marker}%`);
    expect(rowsError).toBeNull();
    expect(rows).toHaveLength(2);
    expect(new Set(rows?.map((row) => row.resource_id))).toEqual(
      new Set(resourceIds),
    );
    expect(
      rows?.every(
        (row) =>
          row.after_hours_minutes === 55 &&
          row.after_hours_approved_by === ownerUserId &&
          row.after_hours_staff_consent === true,
      ),
    ).toBe(true);
  });

  test("preserves null resource assignment when the salon has no resource mode", async () => {
    const { error: salonError } = await db
      .from("salons")
      .update({ resources_enabled: false })
      .eq("id", salonId);
    if (salonError) throw new Error(salonError.message);

    const startIso = salonWallTimeToUtcIso(dateYmd, 16 * 60, TIMEZONE);
    const marker = `LegacyStaffMode-${randomUUID()}`;
    const { data, error } = await publicDb.rpc("insert_group_bookings", {
      p_bookings: payloadFor({
        salonId,
        serviceId,
        staffIds: staffIds.slice(0, 2),
        startIso,
        marker,
      }),
    });

    expect(error).toBeNull();
    expect(data as RpcResult).toMatchObject({ success: true });

    const { data: rows, error: rowsError } = await db
      .from("bookings")
      .select("resource_id")
      .eq("salon_id", salonId)
      .like("client_name", `${marker}%`);
    expect(rowsError).toBeNull();
    expect(rows).toHaveLength(2);
    expect(rows?.every((row) => row.resource_id === null)).toBe(true);
  });
});
