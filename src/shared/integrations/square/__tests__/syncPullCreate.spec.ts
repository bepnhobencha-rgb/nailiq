import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  sendOwnerBookingNotification: vi.fn(),
  looseServiceClient: vi.fn(),
  getSquareConfig: vi.fn(),
  listBookings: vi.fn(),
  listCatalogItems: vi.fn(),
  getCustomer: vi.fn(),
  cancelSquareBooking: vi.fn(),
  createSquareBooking: vi.fn(),
  updateSquareBookingTime: vi.fn(),
  ensureSquareCustomer: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/shared/dashboard/sendOwnerBookingNotification", () => ({
  sendOwnerBookingNotification: mocks.sendOwnerBookingNotification,
}));
vi.mock("../looseDb", () => ({ looseServiceClient: mocks.looseServiceClient }));
vi.mock("../client", () => ({
  getSquareConfig: mocks.getSquareConfig,
  listBookings: mocks.listBookings,
  listCatalogItems: mocks.listCatalogItems,
  getCustomer: mocks.getCustomer,
  cancelSquareBooking: mocks.cancelSquareBooking,
  createSquareBooking: mocks.createSquareBooking,
  updateSquareBookingTime: mocks.updateSquareBookingTime,
  ensureSquareCustomer: mocks.ensureSquareCustomer,
}));

import { runSquareForwardSync } from "../sync";
import type { SquareBooking, SquareConfig } from "../client";
import type { LooseDb } from "../looseDb";

const NOW = new Date("2026-08-23T12:00:00.000Z");
const SALON_ID = "61000000-0000-4000-8000-000000000001";
const SERVICE_ID = "61000000-0000-4000-8000-000000000002";
const STAFF_ID = "61000000-0000-4000-8000-000000000003";
const RESOURCE_ID = "61000000-0000-4000-8000-000000000004";
const OTHER_RESOURCE_ID = "61000000-0000-4000-8000-000000000005";
const LOCAL_BOOKING_ID = "61000000-0000-4000-8000-000000000006";
const CLIENT_PROFILE_ID = "61000000-0000-4000-8000-000000000011";
const OTHER_CLIENT_PROFILE_ID = "61000000-0000-4000-8000-000000000012";
const SQUARE_BOOKING_ID = "square-inbound-booking-1";
const SQUARE_LOCATION_ID = "square-location-qa";
const SQUARE_TEAM_MEMBER_ID = "square-team-member-qa";
let allowProviderCalls = false;

const baseConfig: SquareConfig = {
  salonId: SALON_ID,
  merchantId: "square-merchant-qa",
  locationId: SQUARE_LOCATION_ID,
  accessToken: "fake-sandbox-token",
  applicationId: "fake-sandbox-app",
  environment: "sandbox",
  currency: "CAD",
  sync: {
    pullCreate: true,
    pullUpdate: true,
    pullCancel: true,
    pushCreate: false,
    pushUpdate: false,
    pushCancel: false,
  },
};

function providerBooking(overrides: Partial<SquareBooking> = {}): SquareBooking {
  return {
    id: SQUARE_BOOKING_ID,
    version: 1,
    status: "ACCEPTED",
    location_id: SQUARE_LOCATION_ID,
    start_at: "2026-08-24T17:00:00.000Z",
    updated_at: "2026-08-23T10:00:00.000Z",
    appointment_segments: [{
      duration_minutes: 30,
      team_member_id: SQUARE_TEAM_MEMBER_ID,
      service_variation_id: "square-variation-qa",
      service_variation_version: 7,
    }],
    ...overrides,
  };
}

type LocalBooking = Record<string, unknown> & {
  id: string;
  salon_id: string;
  square_booking_id: string;
  start_time_utc: string;
  end_time_utc: string;
  status: string;
};

type FakeDbOptions = {
  resourcesEnabled?: boolean;
  initialBookings?: LocalBooking[];
  serviceRows?: Array<Record<string, unknown>>;
  staffRows?: Array<Record<string, unknown>>;
  resourceRows?: Array<Record<string, unknown>>;
  synchronizeExistingLookups?: number;
  bindingRaceProfileId?: string;
  bookingInsertError?: {
    code?: string;
    message: string;
  };
  identityRpcError?: {
    code?: string;
    message: string;
  };
  identityResolveError?: {
    code?: string;
    message: string;
  };
  initialIdentities?: Record<string, {
    clientProfileId: string;
    name: string | null;
    phone: string | null;
  }>;
  errors?: Partial<Record<string, {
    code?: string;
    message: string;
  }>>;
};

function fakeDatabase(options: FakeDbOptions = {}) {
  const bookings: LocalBooking[] = structuredClone(options.initialBookings ?? []);
  const mutations: Array<{ table: string; values: Record<string, unknown> }> = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const identities = new Map<string, {
    clientProfileId: string;
    name: string | null;
    phone: string | null;
  }>(Object.entries(options.initialIdentities ?? {}));
  let bookingSequence = 0;
  let synchronizedLookups = 0;
  let releaseExistingLookups: (() => void) | null = null;
  const existingLookupBarrier = options.synchronizeExistingLookups
    ? new Promise<void>((resolve) => { releaseExistingLookups = resolve; })
    : null;

  const staffRows = options.staffRows ?? [{
    id: STAFF_ID,
    square_team_member_id: SQUARE_TEAM_MEMBER_ID,
  }];
  const resourceRows = options.resourceRows ?? [{
    id: RESOURCE_ID,
    square_team_member_id: SQUARE_TEAM_MEMBER_ID,
  }];

  const from = vi.fn((table: string) => {
    let selected = "";
    let insertValues: Record<string, unknown> | null = null;
    let updateValues: Record<string, unknown> | null = null;
    const filters = new Map<string, unknown>();
    const configuredError = (key: string) => {
      const error = options.errors?.[key];
      return error ? structuredClone(error) : null;
    };

    const matchesFilters = (row: Record<string, unknown>) => {
      for (const [column, value] of filters) {
        if (row[column] !== value) return false;
      }
      return true;
    };

    const list = async () => {
      if (updateValues) {
        const error = configuredError(`${table}:update`);
        if (error) return { data: null, error };
        mutations.push({ table, values: structuredClone(updateValues) });
        if (table === "bookings") {
          for (const booking of bookings) {
            if (matchesFilters(booking)) Object.assign(booking, updateValues);
          }
        }
        return { data: [], error: null };
      }
      if (insertValues) {
        const error = configuredError(`${table}:insert`);
        if (error) return { data: null, error };
        mutations.push({ table, values: structuredClone(insertValues) });
        return { data: [], error: null };
      }
      if (table === "services") {
        return {
          data: structuredClone(options.serviceRows ?? [{
            id: SERVICE_ID,
            name: "Manicure",
            price_cents: 4_000,
          }]),
          error: configuredError("services:list"),
        };
      }
      if (table === "staff") {
        return {
          data: structuredClone(staffRows),
          error: configuredError("staff:list"),
        };
      }
      if (table === "salon_resources") {
        return { data: structuredClone(resourceRows), error: null };
      }
      if (table === "square_booking_writeback_operations") {
        return { data: [], error: null };
      }
      if (table === "bookings") {
        if (selected.startsWith("staff_id,")) {
          return {
            data: bookings.filter((booking) => booking.staff_id != null).map((booking) => ({
              staff_id: booking.staff_id,
              start_time_utc: booking.start_time_utc,
              end_time_utc: booking.end_time_utc,
              status: booking.status,
            })),
            error: configuredError("bookings:staff_occupancy"),
          };
        }
        if (selected.startsWith("resource_id,")) {
          return {
            data: bookings.filter((booking) => booking.resource_id != null).map((booking) => ({
              resource_id: booking.resource_id,
              start_time_utc: booking.start_time_utc,
              end_time_utc: booking.end_time_utc,
              status: booking.status,
            })),
            error: null,
          };
        }
        if (selected === "staff_id, status") {
          return { data: [], error: configuredError("bookings:staff_capacity") };
        }
        if (selected === "id, square_booking_id") {
          return {
            data: bookings
              .filter((booking) => booking.status === "cancelled")
              .map((booking) => ({
                id: booking.id,
                square_booking_id: booking.square_booking_id,
              })),
            error: configuredError("bookings:cancel_inventory"),
          };
        }
        if (selected.startsWith("id, salon_id, service_id")) {
          return { data: [], error: configuredError("bookings:create_inventory") };
        }
        if (selected.startsWith("id, square_booking_id, start_time_utc")) {
          return {
            data: bookings
              .filter((booking) => booking.square_booking_id != null)
              .map((booking) => ({
                id: booking.id,
                square_booking_id: booking.square_booking_id,
                start_time_utc: booking.start_time_utc,
                end_time_utc: booking.end_time_utc,
                local_updated_at: booking.local_updated_at,
                rescheduled_at: booking.rescheduled_at,
              })),
            error: configuredError("bookings:reschedule_inventory"),
          };
        }
        return { data: [], error: null };
      }
      return { data: [], error: null };
    };

    const maybeSingle = async () => {
      if (table === "salons") {
        return {
          data: { resources_enabled: options.resourcesEnabled === true },
          error: null,
        };
      }
      if (table === "client_profiles") {
        const key = filters.has("square_customer_id")
          ? "client_profiles:square_lookup"
          : filters.has("phone")
            ? "client_profiles:phone_lookup"
            : "client_profiles:lookup";
        return { data: null, error: configuredError(key) };
      }
      if (table !== "bookings") return { data: null, error: null };

      if (insertValues) {
        if (options.bookingInsertError) {
          return { data: null, error: structuredClone(options.bookingInsertError) };
        }
        const squareBookingId = String(insertValues.square_booking_id ?? "");
        if (bookings.some((booking) => booking.square_booking_id === squareBookingId)) {
          return {
            data: null,
            error: {
              code: "23505",
              message:
                'duplicate key value violates unique constraint "bookings_square_booking_id_key"',
            },
          };
        }
        const row = {
          ...structuredClone(insertValues),
          id: bookingSequence++ === 0
            ? LOCAL_BOOKING_ID
            : `61000000-0000-4000-8000-${String(bookingSequence).padStart(12, "0")}`,
        } as LocalBooking;
        bookings.push(row);
        mutations.push({ table, values: structuredClone(insertValues) });
        return { data: { id: row.id }, error: null };
      }

      if (updateValues) {
        const error = configuredError(`${table}:update`);
        if (error) return { data: null, error };
        if (
          options.bindingRaceProfileId
          && filters.get("client_profile_id") === null
        ) {
          const racedBooking = bookings.find((booking) => (
            booking.id === filters.get("id")
            && booking.salon_id === filters.get("salon_id")
          ));
          if (racedBooking) {
            racedBooking.client_profile_id = options.bindingRaceProfileId;
          }
        }
        const row = bookings.find((booking) => matchesFilters(booking));
        if (!row) return { data: null, error: null };
        Object.assign(row, updateValues);
        mutations.push({ table, values: structuredClone(updateValues) });
        return { data: structuredClone(row), error: null };
      }

      if (filters.has("square_booking_id") && existingLookupBarrier) {
        synchronizedLookups++;
        if (synchronizedLookups >= options.synchronizeExistingLookups!) {
          releaseExistingLookups?.();
        }
        await existingLookupBarrier;
      }

      const row = bookings.find((booking) => matchesFilters(booking));
      return {
        data: row ? structuredClone(row) : null,
        error: configuredError("bookings:existing_lookup"),
      };
    };

    const query = {
      select: (columns = "*") => { selected = columns; return query; },
      insert: (values: Record<string, unknown>) => { insertValues = values; return query; },
      update: (values: Record<string, unknown>) => { updateValues = values; return query; },
      upsert: () => query,
      delete: () => query,
      eq: (column: string, value: unknown) => { filters.set(column, value); return query; },
      in: () => query,
      is: (column: string, value: unknown) => { filters.set(column, value); return query; },
      not: () => query,
      gt: () => query,
      gte: () => query,
      lt: () => query,
      order: () => query,
      limit: () => query,
      range: () => query,
      maybeSingle,
      single: maybeSingle,
      then: <TResult1 = Awaited<ReturnType<typeof list>>, TResult2 = never>(
        onfulfilled?: ((value: Awaited<ReturnType<typeof list>>) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => list().then(onfulfilled, onrejected),
    };
    return query;
  });

  const rpc = vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
    rpcCalls.push({ fn, args: structuredClone(args) });
    if (fn !== "resolve_square_customer_identity") {
      return { data: null, error: null };
    }
    if (options.identityRpcError) {
      return { data: null, error: structuredClone(options.identityRpcError) };
    }
    const customerId = String(args.p_square_customer_id ?? "");
    const existing = identities.get(customerId);
    if (existing) {
      return {
        data: {
          code: "replayed",
          client_profile_id: existing.clientProfileId,
          name: existing.name,
          phone: existing.phone,
          created_profile: false,
          salon_link_created: false,
        },
        error: null,
      };
    }
    const phone = typeof args.p_phone === "string" ? args.p_phone : null;
    if (!phone) {
      return {
        data: {
          code: "not_found",
          client_profile_id: null,
          name: null,
          phone: null,
          created_profile: false,
          salon_link_created: false,
        },
        error: null,
      };
    }
    if (options.identityResolveError) {
      return { data: null, error: structuredClone(options.identityResolveError) };
    }
    const identity = {
      clientProfileId: CLIENT_PROFILE_ID,
      name: typeof args.p_name === "string" ? args.p_name : null,
      phone,
    };
    identities.set(customerId, identity);
    mutations.push({
      table: "square_customer_identities",
      values: { square_customer_id: customerId, client_profile_id: CLIENT_PROFILE_ID },
    });
    return {
      data: {
        code: "created_profile",
        client_profile_id: identity.clientProfileId,
        name: identity.name,
        phone: identity.phone,
        created_profile: true,
        salon_link_created: true,
      },
      error: null,
    };
  });

  return {
    db: { from, rpc } as unknown as LooseDb,
    bookings,
    mutations,
    rpcCalls,
  };
}

describe("Square inbound pull-create contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    allowProviderCalls = false;
    mocks.getSquareConfig.mockResolvedValue(baseConfig);
    mocks.listBookings.mockResolvedValue([providerBooking()]);
    mocks.listCatalogItems.mockResolvedValue([{
      id: "square-catalog-item-qa",
      name: "Manicure",
      variations: [{ id: "square-variation-qa", version: 7 }],
    }]);
  });

  afterEach(() => {
    if (!allowProviderCalls) {
      expect(mocks.cancelSquareBooking).not.toHaveBeenCalled();
      expect(mocks.createSquareBooking).not.toHaveBeenCalled();
      expect(mocks.updateSquareBookingTime).not.toHaveBeenCalled();
      expect(mocks.ensureSquareCustomer).not.toHaveBeenCalled();
    }
    vi.useRealTimers();
  });

  it("imports one exact staff-mapped appointment and replays without a duplicate", async () => {
    const state = fakeDatabase();
    mocks.looseServiceClient.mockReturnValue(state.db);

    await expect(runSquareForwardSync(SALON_ID)).resolves.toMatchObject({
      pulled: 1,
      inserted: 1,
      skipped: 0,
    });
    expect(state.bookings).toHaveLength(1);
    expect(state.bookings[0]).toMatchObject({
      salon_id: SALON_ID,
      service_id: SERVICE_ID,
      staff_id: STAFF_ID,
      resource_id: null,
      booking_channel: "square",
      source: "appointment",
      square_booking_id: SQUARE_BOOKING_ID,
    });
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.sendOwnerBookingNotification).not.toHaveBeenCalled();

    await expect(runSquareForwardSync(SALON_ID)).resolves.toMatchObject({
      pulled: 1,
      inserted: 0,
      updated: 0,
    });
    expect(state.bookings).toHaveLength(1);
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it("binds a fake Square customer through the scoped resolver and booking FK", async () => {
    const state = fakeDatabase();
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.listBookings.mockResolvedValue([
      providerBooking({ customer_id: "square-customer-qa" }),
    ]);
    mocks.getCustomer.mockResolvedValue({
      id: "square-customer-qa",
      given_name: "Scoped",
      family_name: "Client",
      phone_number: "+1 (604) 555-0123",
      email_address: "SCOPED@EXAMPLE.TEST",
    });

    await expect(runSquareForwardSync(SALON_ID)).resolves.toMatchObject({
      inserted: 1,
      customersAdded: 1,
      skipped: 0,
    });
    expect(mocks.getCustomer).toHaveBeenCalledTimes(1);
    expect(state.rpcCalls.filter(({ fn }) => (
      fn === "resolve_square_customer_identity"
    ))).toHaveLength(2);
    expect(state.rpcCalls[0]?.args).toMatchObject({
      p_provider_environment: "sandbox",
      p_provider_merchant_id: "square-merchant-qa",
      p_provider_location_id: SQUARE_LOCATION_ID,
      p_square_customer_id: "square-customer-qa",
      p_phone: null,
    });
    expect(state.rpcCalls[1]?.args).toMatchObject({
      p_phone: "16045550123",
      p_name: "Scoped Client",
      p_email: "scoped@example.test",
    });
    expect(state.bookings[0]).toMatchObject({
      client_profile_id: CLIENT_PROFILE_ID,
      client_name: "Scoped Client",
      client_phone: "16045550123",
    });
    expect(state.mutations.some(({ table }) => table === "client_profiles")).toBe(false);
    expect(mocks.sendOwnerBookingNotification).not.toHaveBeenCalled();
  });

  it("backfills only a null customer FK on an existing scoped booking", async () => {
    const customerId = "square-customer-existing";
    const state = fakeDatabase({
      initialBookings: [{
        id: LOCAL_BOOKING_ID,
        salon_id: SALON_ID,
        square_booking_id: SQUARE_BOOKING_ID,
        start_time_utc: "2026-08-24T17:00:00.000Z",
        end_time_utc: "2026-08-24T17:30:00.000Z",
        status: "confirmed",
        staff_id: STAFF_ID,
        client_profile_id: null,
      }],
      initialIdentities: {
        [customerId]: {
          clientProfileId: CLIENT_PROFILE_ID,
          name: "Existing Client",
          phone: "16045550123",
        },
      },
    });
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.listBookings.mockResolvedValue([providerBooking({ customer_id: customerId })]);

    await expect(runSquareForwardSync(SALON_ID)).resolves.toMatchObject({ inserted: 0 });
    expect(state.bookings[0]?.client_profile_id).toBe(CLIENT_PROFILE_ID);
    expect(state.mutations).toContainEqual({
      table: "bookings",
      values: { client_profile_id: CLIENT_PROFILE_ID },
    });
    expect(mocks.getCustomer).not.toHaveBeenCalled();
  });

  it.each([
    ["accepts an idempotent winner", CLIENT_PROFILE_ID, false],
    ["rejects a different winner", OTHER_CLIENT_PROFILE_ID, true],
  ] as const)("%s when a concurrent writer wins the guarded bind", async (
    _label,
    bindingRaceProfileId,
    shouldReject,
  ) => {
    const customerId = "square-customer-raced";
    const state = fakeDatabase({
      bindingRaceProfileId,
      initialBookings: [{
        id: LOCAL_BOOKING_ID,
        salon_id: SALON_ID,
        square_booking_id: SQUARE_BOOKING_ID,
        start_time_utc: "2026-08-24T17:00:00.000Z",
        end_time_utc: "2026-08-24T17:30:00.000Z",
        status: "confirmed",
        staff_id: STAFF_ID,
        client_profile_id: null,
      }],
      initialIdentities: {
        [customerId]: {
          clientProfileId: CLIENT_PROFILE_ID,
          name: "Raced Client",
          phone: "16045550123",
        },
      },
    });
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.listBookings.mockResolvedValue([providerBooking({ customer_id: customerId })]);

    const outcome = runSquareForwardSync(SALON_ID);
    if (shouldReject) {
      await expect(outcome).rejects.toThrow("square_sync_customer_binding_conflict");
    } else {
      await expect(outcome).resolves.toMatchObject({ inserted: 0 });
    }
    expect(state.bookings[0]?.client_profile_id).toBe(bindingRaceProfileId);
    expect(state.mutations.filter(({ table }) => table === "bookings")).toHaveLength(0);
    expect(mocks.getCustomer).not.toHaveBeenCalled();
  });

  it("fails closed when an existing booking is bound to another profile", async () => {
    const customerId = "square-customer-conflict";
    const state = fakeDatabase({
      initialBookings: [{
        id: LOCAL_BOOKING_ID,
        salon_id: SALON_ID,
        square_booking_id: SQUARE_BOOKING_ID,
        start_time_utc: "2026-08-24T17:00:00.000Z",
        end_time_utc: "2026-08-24T17:30:00.000Z",
        status: "confirmed",
        staff_id: STAFF_ID,
        client_profile_id: OTHER_CLIENT_PROFILE_ID,
      }],
      initialIdentities: {
        [customerId]: {
          clientProfileId: CLIENT_PROFILE_ID,
          name: "Conflicting Client",
          phone: "16045550124",
        },
      },
    });
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.listBookings.mockResolvedValue([providerBooking({ customer_id: customerId })]);

    await expect(runSquareForwardSync(SALON_ID)).rejects.toThrow(
      "square_sync_customer_binding_conflict",
    );
    expect(state.bookings[0]?.client_profile_id).toBe(OTHER_CLIENT_PROFILE_ID);
    expect(state.mutations).toHaveLength(0);
    expect(mocks.getCustomer).not.toHaveBeenCalled();
  });

  it("rejects a mismatched provider customer receipt before identity mutation", async () => {
    const state = fakeDatabase();
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.listBookings.mockResolvedValue([
      providerBooking({ customer_id: "square-customer-requested" }),
    ]);
    mocks.getCustomer.mockResolvedValue({
      id: "square-customer-different",
      given_name: "Wrong",
      family_name: "Identity",
      phone_number: "+16045550199",
    });

    await expect(runSquareForwardSync(SALON_ID)).rejects.toThrow(
      "square_sync_customer_response_mismatch",
    );
    expect(mocks.getCustomer).toHaveBeenCalledWith(
      baseConfig,
      "square-customer-requested",
    );
    expect(state.rpcCalls.filter(({ fn }) => (
      fn === "resolve_square_customer_identity"
    ))).toHaveLength(1);
    expect(state.rpcCalls[0]?.args.p_phone).toBeNull();
    expect(state.mutations.some(({ table }) => (
      table === "square_customer_identities" || table === "bookings"
    ))).toBe(false);
    expect(state.bookings).toHaveLength(0);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("keeps pullCreate hard-off before customer lookup or booking mutation", async () => {
    const state = fakeDatabase();
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.getSquareConfig.mockResolvedValue({
      ...baseConfig,
      sync: { ...baseConfig.sync, pullCreate: false },
    });
    mocks.listBookings.mockResolvedValue([providerBooking({ customer_id: "customer-qa" })]);

    await expect(runSquareForwardSync(SALON_ID)).resolves.toMatchObject({
      inserted: 0,
      skipped: 1,
    });
    expect(state.bookings).toHaveLength(0);
    expect(mocks.getCustomer).not.toHaveBeenCalled();
    expect(state.mutations.some(({ table }) => table === "client_profiles")).toBe(false);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong location", { location_id: "square-location-other", customer_id: "customer-qa" }],
    ["missing location", { location_id: undefined, customer_id: "customer-qa" }],
    ["already cancelled", { status: "CANCELLED_BY_CUSTOMER", customer_id: "customer-qa" }],
    ["unsupported provider status", { status: "FUTURE_UNKNOWN_STATUS", customer_id: "customer-qa" }],
    ["missing segment duration", {
      customer_id: "customer-qa",
      appointment_segments: [{
        team_member_id: SQUARE_TEAM_MEMBER_ID,
        service_variation_id: "square-variation-qa",
        service_variation_version: 7,
      }],
    }],
    ["multiple service segments", {
      customer_id: "customer-qa",
      appointment_segments: [
        {
          duration_minutes: 30,
          team_member_id: SQUARE_TEAM_MEMBER_ID,
          service_variation_id: "square-variation-qa",
          service_variation_version: 7,
        },
        {
          duration_minutes: 15,
          team_member_id: SQUARE_TEAM_MEMBER_ID,
          service_variation_id: "square-variation-second",
          service_variation_version: 8,
        },
      ],
    }],
    ["unmapped team member", {
      customer_id: "customer-qa",
      appointment_segments: [{
        duration_minutes: 30,
        team_member_id: "square-team-member-unmapped",
        service_variation_id: "square-variation-qa",
        service_variation_version: 7,
      }],
    }],
  ] satisfies Array<[string, Partial<SquareBooking>]>) (
    "fails closed for %s without customer or booking mutation",
    async (_label, bookingOverrides) => {
      const state = fakeDatabase();
      mocks.looseServiceClient.mockReturnValue(state.db);
      mocks.listBookings.mockResolvedValue([providerBooking(bookingOverrides)]);

      await expect(runSquareForwardSync(SALON_ID)).resolves.toMatchObject({
        inserted: 0,
        skipped: 1,
      });
      expect(state.bookings).toHaveLength(0);
      expect(mocks.getCustomer).not.toHaveBeenCalled();
      expect(state.mutations.some(({ table }) => table === "client_profiles")).toBe(false);
      expect(mocks.after).not.toHaveBeenCalled();
    },
  );

  it("maps resource mode to resource_id without inventing a staff assignment", async () => {
    const state = fakeDatabase({
      resourcesEnabled: true,
      staffRows: [{ id: STAFF_ID, square_team_member_id: "different-staff-member" }],
      resourceRows: [{
        id: RESOURCE_ID,
        square_team_member_id: SQUARE_TEAM_MEMBER_ID,
        display_order: 1,
      }],
    });
    mocks.looseServiceClient.mockReturnValue(state.db);

    await expect(runSquareForwardSync(SALON_ID)).resolves.toMatchObject({
      inserted: 1,
      skipped: 0,
    });
    expect(state.bookings).toHaveLength(1);
    expect(state.bookings[0]).toMatchObject({
      salon_id: SALON_ID,
      staff_id: null,
      resource_id: RESOURCE_ID,
      square_booking_id: SQUARE_BOOKING_ID,
    });
  });

  it("keeps an exact staff mapping and independently auto-assigns the first free resource", async () => {
    const state = fakeDatabase({
      resourcesEnabled: true,
      initialBookings: [{
        id: "61000000-0000-4000-8000-000000000009",
        salon_id: SALON_ID,
        square_booking_id: "square-existing-resource-occupancy",
        staff_id: "61000000-0000-4000-8000-000000000010",
        resource_id: RESOURCE_ID,
        start_time_utc: "2026-08-24T17:00:00.000Z",
        end_time_utc: "2026-08-24T17:30:00.000Z",
        status: "confirmed",
      }],
      staffRows: [{ id: STAFF_ID, square_team_member_id: SQUARE_TEAM_MEMBER_ID }],
      resourceRows: [
        { id: OTHER_RESOURCE_ID, square_team_member_id: null, display_order: 2 },
        { id: RESOURCE_ID, square_team_member_id: null, display_order: 1 },
      ],
    });
    mocks.looseServiceClient.mockReturnValue(state.db);

    await expect(runSquareForwardSync(SALON_ID)).resolves.toMatchObject({
      inserted: 1,
      skipped: 0,
    });
    expect(state.bookings).toHaveLength(2);
    expect(state.bookings.find((row) => (
      row.square_booking_id === SQUARE_BOOKING_ID
    ))).toMatchObject({
      salon_id: SALON_ID,
      staff_id: STAFF_ID,
      resource_id: OTHER_RESOURCE_ID,
      square_booking_id: SQUARE_BOOKING_ID,
    });
  });

  it("fails closed when the same provider id maps to both staff and resource", async () => {
    const state = fakeDatabase({
      resourcesEnabled: true,
      staffRows: [{ id: STAFF_ID, square_team_member_id: SQUARE_TEAM_MEMBER_ID }],
      resourceRows: [{
        id: RESOURCE_ID,
        square_team_member_id: SQUARE_TEAM_MEMBER_ID,
        display_order: 1,
      }],
    });
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.listBookings.mockResolvedValue([providerBooking({ customer_id: "customer-qa" })]);

    await expect(runSquareForwardSync(SALON_ID)).resolves.toMatchObject({
      inserted: 0,
      skipped: 1,
    });
    expect(state.bookings).toHaveLength(0);
    expect(mocks.getCustomer).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("fails closed when a Square team member maps to multiple active resources", async () => {
    const state = fakeDatabase({
      resourcesEnabled: true,
      staffRows: [{ id: STAFF_ID, square_team_member_id: "different-staff-member" }],
      resourceRows: [
        { id: RESOURCE_ID, square_team_member_id: SQUARE_TEAM_MEMBER_ID },
        { id: OTHER_RESOURCE_ID, square_team_member_id: SQUARE_TEAM_MEMBER_ID },
      ],
    });
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.listBookings.mockResolvedValue([providerBooking({ customer_id: "customer-qa" })]);

    await expect(runSquareForwardSync(SALON_ID)).resolves.toMatchObject({
      inserted: 0,
      skipped: 1,
    });
    expect(state.bookings).toHaveLength(0);
    expect(mocks.getCustomer).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("fails closed when a Square team member maps to multiple active staff", async () => {
    const state = fakeDatabase({
      staffRows: [
        { id: STAFF_ID, square_team_member_id: SQUARE_TEAM_MEMBER_ID },
        {
          id: "61000000-0000-4000-8000-000000000007",
          square_team_member_id: SQUARE_TEAM_MEMBER_ID,
        },
      ],
    });
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.listBookings.mockResolvedValue([providerBooking({ customer_id: "customer-qa" })]);

    await expect(runSquareForwardSync(SALON_ID)).resolves.toMatchObject({
      inserted: 0,
      skipped: 1,
    });
    expect(state.bookings).toHaveLength(0);
    expect(mocks.getCustomer).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("fails closed when normalized active service names are ambiguous", async () => {
    const state = fakeDatabase({
      serviceRows: [
        { id: SERVICE_ID, name: "Manicure", price_cents: 4_000 },
        {
          id: "61000000-0000-4000-8000-000000000008",
          name: "1 - Mani cure",
          price_cents: 4_500,
        },
      ],
    });
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.listBookings.mockResolvedValue([providerBooking({ customer_id: "customer-qa" })]);

    await expect(runSquareForwardSync(SALON_ID)).resolves.toMatchObject({
      inserted: 0,
      skipped: 1,
    });
    expect(state.bookings).toHaveLength(0);
    expect(mocks.getCustomer).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("lets the database uniqueness guard select one winner in a concurrent replay", async () => {
    const state = fakeDatabase({ synchronizeExistingLookups: 2 });
    mocks.looseServiceClient.mockReturnValue(state.db);

    const results = await Promise.all([
      runSquareForwardSync(SALON_ID),
      runSquareForwardSync(SALON_ID),
    ]);

    expect(results.reduce((sum, result) => sum + result.inserted, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.skipped, 0)).toBe(1);
    expect(state.bookings).toHaveLength(1);
    expect(state.bookings[0].square_booking_id).toBe(SQUARE_BOOKING_ID);
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it("fails the run for an unexpected booking insert error instead of clearing health", async () => {
    const state = fakeDatabase({
      bookingInsertError: {
        code: "42501",
        message: "permission denied for table bookings; client material must not leak",
      },
    });
    mocks.looseServiceClient.mockReturnValue(state.db);

    await expect(runSquareForwardSync(SALON_ID)).rejects.toThrow(
      "square_sync_booking_insert_failed:42501",
    );
    expect(state.bookings).toHaveLength(0);
    expect(state.mutations.some(({ table, values }) => (
      table === "square_integrations" && values.last_error === null
    ))).toBe(false);
  });

  it.each([
    ["services:list", "square_sync_service_inventory_unavailable"],
    ["staff:list", "square_sync_staff_inventory_unavailable"],
    ["bookings:staff_occupancy", "square_sync_staff_occupancy_unavailable"],
    ["bookings:existing_lookup", "square_sync_existing_booking_lookup_unavailable"],
  ])(
    "fails the run when required inbound inventory %s cannot be read",
    async (errorKey, expectedMessage) => {
      const state = fakeDatabase({
        errors: { [errorKey]: { code: "42501", message: "read denied with private detail" } },
      });
      mocks.looseServiceClient.mockReturnValue(state.db);

      await expect(runSquareForwardSync(SALON_ID)).rejects.toThrow(expectedMessage);
      expect(state.bookings).toHaveLength(0);
      expect(mocks.getCustomer).not.toHaveBeenCalled();
      expect(state.mutations.some(({ table, values }) => (
        table === "square_integrations" && values.last_error === null
      ))).toBe(false);
    },
  );

  it("fails before customer mutation when the scoped identity lookup is unavailable", async () => {
    const state = fakeDatabase({
      identityRpcError: {
        code: "57014",
        message: "statement timeout with private detail",
      },
    });
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.listBookings.mockResolvedValue([
      providerBooking({ customer_id: "square-customer-qa" }),
    ]);

    await expect(runSquareForwardSync(SALON_ID)).rejects.toThrow(
      "square_sync_customer_identity_unavailable",
    );
    expect(state.bookings).toHaveLength(0);
    expect(mocks.getCustomer).not.toHaveBeenCalled();
    expect(state.mutations.some(({ table }) => table === "client_profiles")).toBe(false);
  });

  it("fails when a new scoped customer identity cannot be persisted", async () => {
    const state = fakeDatabase({
      identityResolveError: {
        code: "42501",
        message: "insert denied with private detail",
      },
    });
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.listBookings.mockResolvedValue([
      providerBooking({ customer_id: "square-customer-qa" }),
    ]);
    mocks.getCustomer.mockResolvedValue({
      id: "square-customer-qa",
      given_name: "QA",
      family_name: "Client",
      phone_number: "+16045550123",
    });

    await expect(runSquareForwardSync(SALON_ID)).rejects.toThrow(
      "square_sync_customer_identity_unavailable",
    );
    expect(state.bookings).toHaveLength(0);
    expect(state.mutations.some(({ table }) => table === "client_profiles")).toBe(false);
  });

  it.each([
    ["bookings:cancel_inventory", "pushCancel", "square_sync_cancel_inventory_unavailable"],
    ["bookings:create_inventory", "pushCreate", "square_sync_create_inventory_unavailable"],
    ["bookings:reschedule_inventory", "pushUpdate", "square_sync_reschedule_inventory_unavailable"],
  ] as const)(
    "fails instead of clearing health when reverse inventory %s cannot be read",
    async (errorKey, toggle, expectedMessage) => {
      const state = fakeDatabase({
        errors: { [errorKey]: { code: "57014", message: "read timeout" } },
      });
      mocks.looseServiceClient.mockReturnValue(state.db);
      mocks.listBookings.mockResolvedValue([]);
      mocks.getSquareConfig.mockResolvedValue({
        ...baseConfig,
        sync: { ...baseConfig.sync, [toggle]: true },
      });

      await expect(runSquareForwardSync(SALON_ID)).rejects.toThrow(expectedMessage);
      expect(state.mutations.some(({ table, values }) => (
        table === "square_integrations" && values.last_error === null
      ))).toBe(false);
    },
  );

  it("fails when the integration health write cannot be persisted", async () => {
    const state = fakeDatabase({
      errors: {
        "square_integrations:update": {
          code: "42501",
          message: "health write denied",
        },
      },
    });
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.listBookings.mockResolvedValue([]);

    await expect(runSquareForwardSync(SALON_ID)).rejects.toThrow(
      "square_sync_health_update_failed",
    );
    expect(state.mutations.some(({ table }) => table === "square_integrations")).toBe(false);
  });

  it("keeps health red when a Square cancel push fails", async () => {
    allowProviderCalls = true;
    const state = fakeDatabase({
      initialBookings: [{
        id: LOCAL_BOOKING_ID,
        salon_id: SALON_ID,
        square_booking_id: SQUARE_BOOKING_ID,
        start_time_utc: "2026-08-24T17:00:00.000Z",
        end_time_utc: "2026-08-24T17:30:00.000Z",
        status: "cancelled",
      }],
    });
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.getSquareConfig.mockResolvedValue({
      ...baseConfig,
      sync: { ...baseConfig.sync, pushCancel: true },
    });
    mocks.cancelSquareBooking.mockRejectedValue(new Error("private provider failure"));

    await expect(runSquareForwardSync(SALON_ID)).rejects.toThrow(
      "square_sync_cancel_push_failed",
    );
    expect(mocks.cancelSquareBooking).toHaveBeenCalledTimes(1);
    expect(mocks.createSquareBooking).not.toHaveBeenCalled();
    expect(mocks.updateSquareBookingTime).not.toHaveBeenCalled();
    expect(state.mutations.some(({ table, values }) => (
      table === "square_integrations" && values.last_error === null
    ))).toBe(false);
  });

  it("rejects a non-capacity booking update error instead of treating it as a skip", async () => {
    const state = fakeDatabase({
      initialBookings: [{
        id: LOCAL_BOOKING_ID,
        salon_id: SALON_ID,
        square_booking_id: SQUARE_BOOKING_ID,
        staff_id: STAFF_ID,
        resource_id: null,
        start_time_utc: "2026-08-24T16:00:00.000Z",
        end_time_utc: "2026-08-24T16:30:00.000Z",
        status: "confirmed",
        local_updated_at: "2026-08-23T09:00:00.000Z",
        rescheduled_at: null,
      }],
      errors: {
        "bookings:update": {
          code: "42501",
          message: "update denied with private detail",
        },
      },
    });
    mocks.looseServiceClient.mockReturnValue(state.db);

    await expect(runSquareForwardSync(SALON_ID)).rejects.toThrow(
      "square_sync_booking_update_failed:42501",
    );
    expect(state.mutations.some(({ table, values }) => (
      table === "square_integrations" && values.last_error === null
    ))).toBe(false);
  });

  it("keeps health red when a Square reschedule push fails", async () => {
    allowProviderCalls = true;
    const state = fakeDatabase({
      initialBookings: [{
        id: LOCAL_BOOKING_ID,
        salon_id: SALON_ID,
        square_booking_id: SQUARE_BOOKING_ID,
        start_time_utc: "2026-08-24T18:00:00.000Z",
        end_time_utc: "2026-08-24T18:30:00.000Z",
        status: "confirmed",
        local_updated_at: "2026-08-23T11:00:00.000Z",
        rescheduled_at: "2026-08-23T11:00:00.000Z",
      }],
    });
    mocks.looseServiceClient.mockReturnValue(state.db);
    mocks.getSquareConfig.mockResolvedValue({
      ...baseConfig,
      sync: { ...baseConfig.sync, pushUpdate: true },
    });
    mocks.updateSquareBookingTime.mockRejectedValue(
      new Error("private provider failure"),
    );

    await expect(runSquareForwardSync(SALON_ID)).rejects.toThrow(
      "square_sync_reschedule_push_failed",
    );
    expect(mocks.updateSquareBookingTime).toHaveBeenCalledTimes(1);
    expect(mocks.cancelSquareBooking).not.toHaveBeenCalled();
    expect(mocks.createSquareBooking).not.toHaveBeenCalled();
    expect(state.mutations.some(({ table, values }) => (
      table === "square_integrations" && values.last_error === null
    ))).toBe(false);
  });
});
