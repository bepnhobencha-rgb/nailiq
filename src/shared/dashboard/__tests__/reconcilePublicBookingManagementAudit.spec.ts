import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const insertedIds = new Set<string>();
const rows: Array<Record<string, unknown>> = [];
const insert = vi.fn(async (row: Record<string, unknown>) => {
  const id = String(row.id);
  if (insertedIds.has(id)) return { error: { code: "23505" } };
  insertedIds.add(id);
  rows.push(row);
  return { error: null };
});

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ from: () => ({ insert }) }),
}));

import { reconcilePublicBookingManagementAudit } from "../reconcilePublicBookingManagementAudit";

const input = {
  bookingId: "11111111-1111-4111-8111-111111111111",
  salonId: "22222222-2222-4222-8222-222222222222",
  requestId: "33333333-3333-4333-8333-333333333333",
  action: "cancel" as const,
  payload: { reason: "customer_management_link" },
};

describe("public booking management audit reconciliation", () => {
  beforeEach(() => {
    insertedIds.clear();
    rows.length = 0;
    insert.mockClear();
  });

  it("fills a lost-before-audit gap and sequential replay remains one event", async () => {
    await reconcilePublicBookingManagementAudit(input);
    await reconcilePublicBookingManagementAudit(input);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ management_request_id: input.requestId });
  });

  it("uses a deterministic primary key so concurrent exact retries have one winner", async () => {
    await Promise.all([
      reconcilePublicBookingManagementAudit(input),
      reconcilePublicBookingManagementAudit(input),
    ]);
    expect(rows).toHaveLength(1);
    expect(insert).toHaveBeenCalledTimes(2);
  });
});
