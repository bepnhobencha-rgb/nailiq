import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), service: vi.fn(), from: vi.fn() }));
vi.mock("@/shared/dashboard/setupActions", () => ({ getDashboardWriteClient: mocks.context }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: mocks.service }));
import { loadGroupCancellationFeeReviewQueue } from "../groupCancellationFeeApprovalActions";

let review: Record<string, unknown>;
let booking: Record<string, unknown>;
let reviewError: unknown;
let bookingError: unknown;
let queries: Array<{ table: string; columns: string; filters: Array<[string, unknown]> }>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockResolvedValue({ role: "owner", salon: { id: "salon-a" } });
  mocks.service.mockReturnValue({ from: mocks.from });
  review = {
    id: "review-a", group_id: "group-a", organizer_booking_id: "booking-a",
    policy_snapshot: { group_size: 3 }, amount_cents: 2500, currency: "CAD",
    card_brand: "VISA", card_last4: "1111", state: "pending_review",
  };
  booking = { id: "booking-a", client_name: "Synthetic QA", group_size: 2, services: { name: "QA service" } };
  reviewError = null;
  bookingError = null;
  queries = [];
  mocks.from.mockImplementation((table: string) => {
    const query = { table, columns: "", filters: [] as Array<[string, unknown]> };
    queries.push(query);
    const chain = {
      select(columns: string) { query.columns = columns; return chain; },
      eq(key: string, value: unknown) { query.filters.push([key, value]); return chain; },
      order() { return chain; },
      async limit() {
        // Faithful PostgreSQL failure: group_size exists on bookings, never on
        // booking_group_cancellation_fee_reviews. Previously this erased queue.
        const invalidColumn = query.columns.split(",").map((key) => key.trim()).includes("group_size");
        return invalidColumn
          ? { data: null, error: { code: "42703", message: "column group_size does not exist" } }
          : { data: reviewError ? null : [review], error: reviewError };
      },
      async in(key: string, value: unknown) {
        query.filters.push([key, value]);
        return { data: bookingError ? null : [booking], error: bookingError };
      },
    };
    return chain;
  });
});

describe("group cancellation fee review queue", () => {
  it("loads the canonical review schema and prioritizes durable party size over current booking", async () => {
    expect(await loadGroupCancellationFeeReviewQueue("qa-salon")).toMatchObject([
      { reviewId: "review-a", groupSize: 3, clientName: "Synthetic QA", serviceName: "QA service", amountCents: 2500 },
    ]);
    expect(queries).toHaveLength(2);
    for (const query of queries) expect(query.filters).toContainEqual(["salon_id", "salon-a"]);
    expect(queries[1].filters).toContainEqual(["id", ["booking-a"]]);
  });

  it.each([undefined, null, {}, [], { group_size: -1 }, { group_size: 1.5 }, { group_size: "invalid" }])(
    "uses organizer size for an absent or malformed snapshot %j", async (snapshot) => {
      review.policy_snapshot = snapshot;
      expect((await loadGroupCancellationFeeReviewQueue("qa-salon"))[0].groupSize).toBe(2);
    },
  );

  it("does not invent a party size when neither stored source is valid", async () => {
    review.policy_snapshot = {};
    booking.group_size = null;
    expect((await loadGroupCancellationFeeReviewQueue("qa-salon"))[0].groupSize).toBe(0);
  });

  it.each(["review", "booking"])("surfaces a %s query failure without raw database details", async (stage) => {
    const error = { code: "42703", message: "sensitive raw provider/customer diagnostics" };
    if (stage === "review") reviewError = error;
    else bookingError = error;
    await expect(loadGroupCancellationFeeReviewQueue("qa-salon")).rejects.toThrow(/^group_cancellation_fee_queue_unavailable$/);
  });

  it("keeps not-applicable reviews out of the decision queue", async () => {
    review.state = "not_applicable";
    expect(await loadGroupCancellationFeeReviewQueue("qa-salon")).toEqual([]);
  });

  it.each([null, { role: "receptionist", salon: { id: "salon-a" } }, { role: "nail_tech", salon: { id: "salon-a" } }])(
    "does not create a privileged client for unauthorized viewers", async (context) => {
      mocks.context.mockResolvedValue(context);
      expect(await loadGroupCancellationFeeReviewQueue("qa-salon")).toEqual([]);
      expect(mocks.service).not.toHaveBeenCalled();
    },
  );

  it("allows a server-resolved admin", async () => {
    mocks.context.mockResolvedValue({ role: "admin", salon: { id: "salon-a" } });
    expect(await loadGroupCancellationFeeReviewQueue("qa-salon")).toHaveLength(1);
  });
});
