import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import {
  salonDateOffset,
  salonDayRangeUtc,
  salonWallTimeToUtcCandidates,
  salonWallTimeToUtcIso,
} from "@/shared/lib/salonTime";

import {
  cleanupTestSalon,
  cleanupTestUser,
  seedTestSalonMember,
  setTestStaffCapabilities,
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
const DST_FOLD_ZONE = "America/Toronto";
const DAY_KEYS_BY_IDX = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
] as const;
const SLUG = "e2e-group-resource-integrity";
const FOREIGN_SLUG = "e2e-group-resource-integrity-foreign";
const BLOCK_MINUTES = 55;
let phoneBatch = 0;

type RpcResult = {
  success?: boolean;
  code?: string;
  group_id?: string;
  booking_ids?: string[];
  idempotent_replay?: boolean;
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

function nextFallFoldDateYmd(timezone: string): string {
  for (let offset = 1; offset <= 365; offset += 1) {
    const candidate = salonDateOffset(timezone, offset);
    const { startUtc, endUtc } = salonDayRangeUtc(candidate, timezone);
    if (Date.parse(endUtc) - Date.parse(startUtc) === 25 * 60 * 60_000) {
      return candidate;
    }
  }
  throw new Error("resource integrity fixture could not find the next DST fold");
}

function localHm(utcIso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(utcIso));
  const hour = parts.find((part) => part.type === "hour")?.value ?? "";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "";
  return `${hour}:${minute}`;
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
  addonServiceIds?: string[];
  blockMinutes?: number;
}): GroupPayloadMember[] {
  const batch = phoneBatch++;
  const idempotencyKey = randomUUID();
  const endIso = new Date(
    Date.parse(input.startIso) + (input.blockMinutes ?? BLOCK_MINUTES) * 60_000,
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
    addon_service_ids: input.addonServiceIds ?? [],
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
  let addonServiceId = "";
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

    const { data: addon, error: addonError } = await db
      .from("services")
      .insert({
        salon_id: salonId,
        name: "Integrity Add-on",
        price_cents: 1200,
        duration_minutes: 10,
        buffer_minutes: 0,
        is_addon: true,
        addon_timing: "sequential",
      })
      .select("id")
      .single();
    if (addonError || !addon?.id) {
      throw new Error(addonError?.message ?? "add-on fixture is incomplete");
    }
    addonServiceId = String(addon.id);

    const foreign = await seedGroupTestSalon(FOREIGN_SLUG);
    foreignSalonId = foreign.salonId;
    foreignServiceId = foreign.serviceIds[0] ?? "";
    foreignStaffId = foreign.staffIds[0] ?? "";
    if (!foreignServiceId || !foreignStaffId) {
      throw new Error("foreign tenant fixture is incomplete");
    }

    const fullCapability = Array.from(
      new Set([...seeded.serviceIds, addonServiceId]),
    );
    await setTestStaffCapabilities(
      salonId,
      String(fourthStaff.id),
      fullCapability,
    );
    for (const staffId of seeded.staffIds) {
      await setTestStaffCapabilities(salonId, staffId, fullCapability);
    }

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
        code: "staff_incapable",
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

  test("replays one durable group result and commits de-duplicated add-ons exactly once", async () => {
    const startIso = salonWallTimeToUtcIso(dateYmd, 15 * 60, TIMEZONE);
    const marker = `DurableReplay-${randomUUID()}`;
    const payload = payloadFor({
      salonId,
      serviceId,
      staffIds: staffIds.slice(0, 2),
      startIso,
      marker,
      addonServiceIds: [addonServiceId, addonServiceId],
      blockMinutes: BLOCK_MINUTES + 10,
    });

    const first = await invokePrivateGroupBoundary(payload);
    expect(first).toMatchObject({ success: true });
    expect(first.booking_ids).toHaveLength(2);

    const replay = await invokePrivateGroupBoundary(payload);
    expect(replay).toMatchObject({
      success: true,
      booking_ids: first.booking_ids,
      group_id: first.group_id,
      idempotent_replay: true,
    });

    const changed = payload.map((row, index) =>
      index === 0 ? { ...row, client_name: `${row.client_name}-changed` } : row,
    );
    await expect(invokePrivateGroupBoundary(changed)).resolves.toMatchObject({
      success: false,
      code: "idempotency_conflict",
    });

    const { data: bookings, error: bookingRowsError } = await db
      .from("bookings")
      .select("id, price_cents, addon_price_cents")
      .in("id", first.booking_ids ?? []);
    expect(bookingRowsError).toBeNull();
    expect(bookings).toHaveLength(2);
    expect(bookings?.every((row) => row.addon_price_cents === 1200)).toBe(true);

    const { data: itemization, error: itemizationError } = await db
      .from("booking_addons")
      .select("booking_id, service_id, price_cents")
      .in("booking_id", first.booking_ids ?? []);
    expect(itemizationError).toBeNull();
    expect(itemization).toHaveLength(2);
    expect(itemization?.every((row) => row.service_id === addonServiceId)).toBe(true);
    expect(itemization?.every((row) => row.price_cents === 1200)).toBe(true);
  });

  test("serializes a group against an individual booking on shared resource locks", async () => {
    const startIso = salonWallTimeToUtcIso(dateYmd, 14 * 60 + 30, TIMEZONE);
    const endIso = new Date(Date.parse(startIso) + BLOCK_MINUTES * 60_000).toISOString();
    const marker = `GroupIndividualRace-${randomUUID()}`;

    const [groupAttempt, individualAttempt] = await Promise.all([
      db.rpc("insert_group_bookings", {
        p_bookings: payloadFor({
          salonId,
          serviceId,
          staffIds: staffIds.slice(0, 2),
          startIso,
          marker: `${marker}-group`,
        }),
      }),
      db.rpc("create_public_booking", {
        p_salon_id: salonId,
        p_service_id: serviceId,
        p_staff_id: staffIds[2],
        p_client_name: `${marker}-individual`,
        p_client_phone: "16045559876",
        p_start_time_utc: startIso,
        p_end_time_utc: endIso,
        p_status: "confirmed",
        p_price_cents: 0,
        p_client_notes: null,
        p_addon_service_id: null,
        p_addon_price_cents: null,
        p_client_email: null,
        p_resource_id: null,
      }),
    ]);

    const groupOk =
      groupAttempt.error === null &&
      (groupAttempt.data as RpcResult | null)?.success === true;
    const individualJson = individualAttempt.data as
      | { success?: boolean; booking_id?: string }
      | null;
    const individualOk =
      individualAttempt.error === null && individualJson?.success === true;
    expect(Number(groupOk) + Number(individualOk)).toBe(1);

    const { data: rows, error: rowsError } = await db
      .from("bookings")
      .select("id, resource_id")
      .eq("salon_id", salonId)
      .like("client_name", `${marker}%`);
    expect(rowsError).toBeNull();
    expect(rows).toHaveLength(groupOk ? 2 : 1);
    expect(rows?.every((row) => row.resource_id !== null)).toBe(true);
    expect(new Set(rows?.map((row) => row.resource_id)).size).toBe(rows?.length);
  });

  test("keeps elapsed duration authoritative through a Canadian fall-back fold", async () => {
    const foldDateYmd = nextFallFoldDateYmd(DST_FOLD_ZONE);
    const startIso = salonWallTimeToUtcIso(foldDateYmd, 90, DST_FOLD_ZONE);
    const marker = `DstFold-${randomUUID()}`;
    const dayKey = DAY_KEYS_BY_IDX[dayOfWeek(foldDateYmd)];
    if (!dayKey) throw new Error("DST fold fixture has no day key");

    const { data: salonRow, error: salonReadError } = await db
      .from("salons")
      .select("opening_hours, timezone")
      .eq("id", salonId)
      .single();
    if (salonReadError) throw new Error(salonReadError.message);
    const previousHours = salonRow.opening_hours as Record<string, unknown>;
    const previousTimezone = String(salonRow.timezone);
    const foldHours = {
      ...previousHours,
      [dayKey]: { open: "00:00", close: "23:59", closed: false },
    };
    const { error: hoursUpdateError } = await db
      .from("salons")
      .update({ opening_hours: foldHours, timezone: DST_FOLD_ZONE })
      .eq("id", salonId);
    if (hoursUpdateError) throw new Error(hoursUpdateError.message);
    try {
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
      const result = data as RpcResult;
      expect(result).toMatchObject({ success: true });

      const { data: rows, error: rowsError } = await db
        .from("bookings")
        .select("start_time_utc, end_time_utc")
        .in("id", result.booking_ids ?? []);
      expect(rowsError).toBeNull();
      expect(rows).toHaveLength(2);
      for (const row of rows ?? []) {
        expect(row.start_time_utc).toBe(startIso);
        expect(
          Date.parse(String(row.end_time_utc)) -
            Date.parse(String(row.start_time_utc)),
        ).toBe(BLOCK_MINUTES * 60_000);
        expect(localHm(String(row.start_time_utc), DST_FOLD_ZONE)).toBe("01:30");
        // 55 elapsed minutes crosses the repeated hour, so the ending wall
        // time legitimately looks five minutes earlier.
        expect(localHm(String(row.end_time_utc), DST_FOLD_ZONE)).toBe("01:25");
      }
    } finally {
      const { error: restoreHoursError } = await db
        .from("salons")
        .update({
          opening_hours: previousHours,
          timezone: previousTimezone,
        })
        .eq("id", salonId);
      if (restoreHoursError) throw new Error(restoreHoursError.message);
    }
  });

  test("round-trips the selected occurrence of a repeated reschedule wall time", async ({
    request,
  }) => {
    const foldDateYmd = nextFallFoldDateYmd(DST_FOLD_ZONE);
    const dayKey = DAY_KEYS_BY_IDX[dayOfWeek(foldDateYmd)];
    if (!dayKey) throw new Error("DST fold fixture has no day key");
    const repeatedCandidates = salonWallTimeToUtcCandidates(
      foldDateYmd,
      90,
      DST_FOLD_ZONE,
    );
    expect(repeatedCandidates).toHaveLength(2);
    const selectedSecondOccurrence = repeatedCandidates[1] ?? "";

    const { data: salonRow, error: salonReadError } = await db
      .from("salons")
      .select("opening_hours, timezone")
      .eq("id", salonId)
      .single();
    if (salonReadError) throw new Error(salonReadError.message);
    const previousHours = salonRow.opening_hours as Record<string, unknown>;
    const previousTimezone = String(salonRow.timezone);
    const foldHours = {
      ...previousHours,
      [dayKey]: { open: "00:00", close: "23:59", closed: false },
    };
    const { error: hoursUpdateError } = await db
      .from("salons")
      .update({ opening_hours: foldHours, timezone: DST_FOLD_ZONE })
      .eq("id", salonId);
    if (hoursUpdateError) throw new Error(hoursUpdateError.message);
    const { error: shiftDeleteError } = await db
      .from("staff_shifts")
      .delete()
      .eq("salon_id", salonId)
      .eq("staff_id", staffIds[0])
      .eq("day_of_week", dayKey);
    if (shiftDeleteError) throw new Error(shiftDeleteError.message);

    try {
      const originalStart = salonWallTimeToUtcIso(
        foldDateYmd,
        20 * 60,
        DST_FOLD_ZONE,
      );
      const { data: booking, error: bookingError } = await db
        .from("bookings")
        .insert({
          salon_id: salonId,
          staff_id: staffIds[0],
          service_id: serviceId,
          resource_id: resourceIds[0],
          client_name: `DstReschedule-${randomUUID()}`,
          client_phone: "16045559001",
          start_time_utc: originalStart,
          end_time_utc: new Date(
            Date.parse(originalStart) + BLOCK_MINUTES * 60_000,
          ).toISOString(),
          status: "confirmed",
        })
        .select("id")
        .single();
      if (bookingError || !booking?.id) {
        throw new Error(bookingError?.message ?? "DST reschedule booking failed");
      }
      const { data: token, error: tokenError } = await db
        .from("booking_reminder_tokens")
        .insert({
          salon_id: salonId,
          booking_id: booking.id,
          expires_at: new Date(Date.now() + 366 * 24 * 60 * 60_000).toISOString(),
        })
        .select("id")
        .single();
      if (tokenError || !token?.id) {
        throw new Error(tokenError?.message ?? "DST reschedule token failed");
      }

      const slotsResponse = await request.get(
        `/api/booking/reschedule-slots?token=${token.id}&date=${foldDateYmd}`,
      );
      expect(slotsResponse.ok()).toBe(true);
      const slotsJson = (await slotsResponse.json()) as {
        slotOptions?: Array<{
          label: string;
          displayLabel: string;
          startUtc: string;
        }>;
      };
      const repeated = (slotsJson.slotOptions ?? []).filter(
        (slot) => slot.label === "1:30 AM",
      );
      expect(repeated).toHaveLength(2);
      expect(repeated.map((slot) => slot.startUtc)).toEqual(repeatedCandidates);
      expect(new Set(repeated.map((slot) => slot.displayLabel)).size).toBe(2);

      const actionResponse = await request.post(
        "/api/booking/reschedule-action",
        {
          data: {
            token: token.id,
            date: foldDateYmd,
            slotLabel: "1:30 AM",
            startUtc: selectedSecondOccurrence,
          },
        },
      );
      const actionJson = (await actionResponse.json()) as {
        ok?: boolean;
        code?: string;
        newStartUtc?: string;
      };
      expect(
        actionJson.ok,
        `reschedule failed: ${JSON.stringify(actionJson)}`,
      ).toBe(true);
      expect(actionJson.newStartUtc).toBe(selectedSecondOccurrence);

      const { data: moved, error: movedError } = await db
        .from("bookings")
        .select("start_time_utc, end_time_utc")
        .eq("id", booking.id)
        .single();
      expect(movedError).toBeNull();
      expect(moved?.start_time_utc).toBe(selectedSecondOccurrence);
      expect(
        Date.parse(String(moved?.end_time_utc)) -
          Date.parse(String(moved?.start_time_utc)),
      ).toBe(BLOCK_MINUTES * 60_000);
    } finally {
      const { error: restoreHoursError } = await db
        .from("salons")
        .update({
          opening_hours: previousHours,
          timezone: previousTimezone,
        })
        .eq("id", salonId);
      if (restoreHoursError) throw new Error(restoreHoursError.message);
    }
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
