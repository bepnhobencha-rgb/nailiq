import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  serviceClient: vi.fn(),
  parse: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.serviceClient,
}));
vi.mock(
  "@/shared/booking/groupBookingPricing",
  async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/shared/booking/groupBookingPricing")>()),
    parseGroupBookingPricingQuote: mocks.parse,
  }),
);
vi.mock("@/shared/booking/groupBookingPricingServer", () => ({
  createGroupBookingsAuthoritative: mocks.create,
}));

import { replayCommittedDeskGroup } from "@/shared/dashboard/deskGroupReplay";

const salonId = "11111111-1111-4111-8111-111111111111";
const requestId = "21111111-1111-4111-8111-111111111111";
const groupId = "31111111-1111-4111-8111-111111111111";
const bookingIds = [
  "41111111-1111-4111-8111-111111111111",
  "51111111-1111-4111-8111-111111111111",
];
const serviceIds = [
  "61111111-1111-4111-8111-111111111111",
  "71111111-1111-4111-8111-111111111111",
];
const staffIds = [
  "81111111-1111-4111-8111-111111111111",
  "91111111-1111-4111-8111-111111111111",
];
const addonId = "a1111111-1111-4111-8111-111111111111";
const fingerprint = "a".repeat(64);

const members = [
  {
    name: "Mai",
    phone: "(604) 555-0100",
    email: "MAI@example.test",
    notes: "Window",
    serviceId: serviceIds[0],
    staffId: staffIds[0],
    staffRequestedByClient: true,
    date: "2026-08-21",
    time: "10:00",
    waveNumber: 1,
    addonServiceIds: [addonId],
  },
  {
    name: "Guest 2",
    phone: "",
    serviceId: serviceIds[1],
    staffId: staffIds[1],
    staffRequestedByClient: false,
    date: "2026-08-21",
    time: "10:30",
    waveNumber: 2,
    addonServiceIds: [],
  },
];

const pricing = {
  pricingFingerprint: fingerprint,
  groupSize: 2,
  memberQuotes: [
    { addonServiceIds: [addonId] },
    { addonServiceIds: [] },
  ],
};

const persistedRows = [
  {
    id: bookingIds[0],
    status: "confirmed",
    group_id: groupId,
    service_id: serviceIds[0],
    staff_id: staffIds[0],
    client_name: "Mai",
    client_phone: "16045550100",
    client_email: "mai@example.test",
    client_notes: "Window",
    start_time_utc: "2026-08-21T10:00:00.000Z",
    end_time_utc: "2026-08-21T11:00:00.000Z",
    staff_requested_by_client: true,
    wave_number: 1,
    seat_together: true,
    client_locale: "en",
    resource_id: null,
    booking_addons: [{ service_id: addonId }],
  },
  {
    id: bookingIds[1],
    status: "confirmed",
    group_id: groupId,
    service_id: serviceIds[1],
    staff_id: staffIds[1],
    client_name: "Guest 2",
    client_phone: null,
    client_email: null,
    client_notes: null,
    start_time_utc: "2026-08-21T10:30:00.000Z",
    end_time_utc: "2026-08-21T11:15:00.000Z",
    staff_requested_by_client: false,
    wave_number: 2,
    seat_together: true,
    client_locale: "en",
    resource_id: null,
    booking_addons: [],
  },
];

function single(result: unknown) {
  const chain = {
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue(result),
  };
  chain.eq.mockReturnValue(chain);
  return chain;
}

function database(organizerError: unknown = null) {
  return {
    from: vi.fn((table: string) => ({
      select: vi.fn((columns: string) => {
        if (table === "salons") {
          return single({ data: { timezone: "UTC" }, error: null });
        }
        if (columns.includes("public_booking_pricing_snapshot")) {
          return single({
            data: organizerError
              ? null
              : {
                  id: bookingIds[0],
                  group_id: groupId,
                  public_booking_pricing_snapshot: {
                    group_id: groupId,
                    booking_ids: bookingIds,
                  },
                },
            error: organizerError,
          });
        }
        const chain = {
          eq: vi.fn(),
          in: vi.fn().mockResolvedValue({ data: persistedRows, error: null }),
        };
        chain.eq.mockReturnValue(chain);
        return chain;
      }),
    })),
  };
}

const intent = {
  salonId,
  members,
  seatTogether: true,
  language: "en" as const,
  idempotencyKey: requestId,
};

describe("normal desk Group durable replay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.serviceClient.mockReturnValue(database());
    mocks.parse.mockReturnValue(pricing);
    mocks.create.mockResolvedValue({
      ok: true,
      idempotent: true,
      groupId,
      bookingIds,
      pricing,
    });
  });

  it("returns the same committed group/booking IDs through DB replay", async () => {
    await expect(replayCommittedDeskGroup(intent)).resolves.toEqual({
      kind: "replayed",
      groupId,
      bookingIds,
      pricing,
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      salonId,
      idempotencyKey: requestId,
      expectedPricingFingerprint: fingerprint,
      bookings: [
        expect.objectContaining({ clientPhone: "16045550100" }),
        expect.objectContaining({ clientPhone: null }),
      ],
    }));
  });

  it("fails closed before create on changed intent or an unreadable lookup", async () => {
    await expect(replayCommittedDeskGroup({
      ...intent,
      members: [{ ...members[0], name: "Changed" }, members[1]],
    })).resolves.toEqual({ kind: "conflict" });
    expect(mocks.create).not.toHaveBeenCalled();

    mocks.serviceClient.mockReturnValueOnce(database(new Error("lookup failed")));
    await expect(replayCommittedDeskGroup(intent)).resolves.toEqual({
      kind: "unavailable",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
