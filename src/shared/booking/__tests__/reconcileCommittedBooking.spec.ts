import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { reconcileCommittedBooking } from "@/shared/booking/reconcileCommittedBooking";

describe("committed booking post-commit reconciliation", () => {
  it("repairs a lost-response replay without duplicating claimed providers or audit", async () => {
    const durableProviderClaims = new Set<string>();
    const durableAuditKeys = new Set<string>();
    let stampCount = 0;
    let ownerProviderSends = 0;
    let customerProviderSends = 0;
    let auditWrites = 0;
    let protectionRuns = 0;

    const claimedProviderJob = (key: string, send: () => void) => async () => {
      if (durableProviderClaims.has(key)) return;
      durableProviderClaims.add(key);
      send();
    };

    const input = {
      bookingId: "11111111-1111-4111-8111-111111111111",
      salonId: "22222222-2222-4222-8222-222222222222",
      channel: "voice" as const,
      stamp: async () => {
        stampCount += 1;
      },
      ownerNotify: {
        salonId: "22222222-2222-4222-8222-222222222222",
        bookingId: "11111111-1111-4111-8111-111111111111",
        event: "new" as const,
      },
      audit: {
        actorUserId: null,
        actorRole: "system" as const,
        eventType: "booking_created" as const,
        payload: { source: "voice" },
      },
      protectionChannel: "voice" as const,
      jobs: [
        {
          name: "customer confirmation",
          run: claimedProviderJob("customer", () => {
            customerProviderSends += 1;
          }),
        },
      ],
    };

    const dependencies = {
      ownerNotify: vi.fn(
        claimedProviderJob("owner", () => {
          ownerProviderSends += 1;
        }),
      ),
      protect: vi.fn(async () => {
        protectionRuns += 1;
      }),
      auditExists: vi.fn(async ({ reconciliationKey }) =>
        durableAuditKeys.has(reconciliationKey),
      ),
      audit: vi.fn(async (event) => {
        durableAuditKeys.add(String(event.payload?.postCommitReconciliationKey));
        auditWrites += 1;
      }),
    };

    // First request committed and began reconciliation, but its response was
    // lost. The identical retry reconciles the same committed row again.
    await reconcileCommittedBooking(input, dependencies);
    await reconcileCommittedBooking(input, dependencies);

    expect(stampCount).toBe(2);
    expect(protectionRuns).toBe(2);
    expect(ownerProviderSends).toBe(1);
    expect(customerProviderSends).toBe(1);
    expect(auditWrites).toBe(1);
  });

  it("continues independent reconciliation jobs when one fails", async () => {
    const completed: string[] = [];
    await reconcileCommittedBooking(
      {
        bookingId: "11111111-1111-4111-8111-111111111111",
        salonId: "22222222-2222-4222-8222-222222222222",
        channel: "desk",
        jobs: [
          { name: "failed", run: async () => { throw new Error("lost"); } },
          { name: "survives", run: async () => { completed.push("survives"); } },
        ],
      },
      {
        ownerNotify: vi.fn(),
        protect: vi.fn(),
        auditExists: vi.fn(async () => false),
        audit: vi.fn(),
      },
    );
    expect(completed).toEqual(["survives"]);
  });
});
