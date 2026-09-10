import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ createService: vi.fn(), rate: vi.fn() }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: mocks.createService }));
vi.mock("@/shared/lib/inAppRateLimit", () => ({
  clientIp: () => "127.0.0.1",
  durableRateLimitKey: () => "qa-customer-recognition",
  isOverRateLimit: mocks.rate,
}));
import { GET } from "./route";

const salonId = "22222222-2222-4222-8222-222222222222";
const phone = "16045550000";
function chain(data: unknown) {
  const value = {
    select: vi.fn(), eq: vi.fn(), is: vi.fn(), not: vi.fn(),
    limit: vi.fn(), maybeSingle: vi.fn(),
    then: (resolve: (result: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve),
  };
  for (const fn of [value.select, value.eq, value.is, value.not, value.limit, value.maybeSingle]) fn.mockReturnValue(value);
  return value;
}

beforeEach(() => { vi.resetAllMocks(); mocks.rate.mockResolvedValue(false); });

it.each([
  { label: "profile removed but previous booking remains", profile: null, bookings: [{ id: "qa-booking" }], expected: { found: true, isVip: false } },
  { label: "new salon with no profile or booking history", profile: null, bookings: [], expected: { found: false } },
  { label: "profile alone still recognizes the customer", profile: { is_vip: true }, bookings: [], expected: { found: true, isVip: true } },
])("recognition: $label", async ({ profile, bookings, expected }) => {
  const salonQuery = chain({ id: salonId, archived_at: null });
  const profileQuery = chain(profile);
  const bookingQuery = chain(bookings);
  const from = vi.fn((table: string) => {
    if (table === "salons") return salonQuery;
    if (table === "client_profiles") return profileQuery;
    if (table === "bookings") return bookingQuery;
    throw new Error(`Unexpected table: ${table}`);
  });
  mocks.createService.mockReturnValue({ from });
  const result = await GET(new NextRequest(`http://localhost/api/customer/${phone}?salon_id=${salonId}`), {
    params: Promise.resolve({ phone }),
  });
  expect(result.status).toBe(200);
  // Exact shape also guards against returning name/phone/history before verification.
  expect(await result.json()).toEqual(expected);
  expect(profileQuery.eq).toHaveBeenCalledWith("phone", phone);
  expect(profileQuery.is).toHaveBeenCalledWith("deleted_at", null);
  if (!profile) {
    expect(bookingQuery.eq).toHaveBeenCalledWith("salon_id", salonId);
    expect(bookingQuery.eq).toHaveBeenCalledWith("client_phone", phone);
    expect(bookingQuery.not).toHaveBeenCalledWith("status", "eq", "cancelled");
  } else {
    expect(from).not.toHaveBeenCalledWith("bookings");
  }
});
