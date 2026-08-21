import { describe, expect, it, vi } from "vitest";

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
  createServiceRoleClient: () => ({
    from: () => ({ insert }),
  }),
}));

import { reconcileDeskGroupCreationAudit } from "@/shared/dashboard/reconcileDeskGroupAudit";

const input = {
  bookingIds: [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ],
  salonId: "33333333-3333-4333-8333-333333333333",
  actorUserId: "44444444-4444-4444-8444-444444444444",
  actorRole: "owner" as const,
  requestId: "55555555-5555-4555-8555-555555555555",
  afterHours: false,
  staffIds: ["66666666-6666-4666-8666-666666666666"],
};

describe("desk group creation audit reconciliation", () => {
  it("fills a lost-before-audit gap and exact retries retain one event per booking", async () => {
    insertedIds.clear();
    rows.length = 0;
    await reconcileDeskGroupCreationAudit(input);
    await reconcileDeskGroupCreationAudit(input);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(rows.every((row) =>
      (row.payload as { group_request_id?: string }).group_request_id === input.requestId,
    )).toBe(true);
  });

  it("uses deterministic primary keys so concurrent retries have one winner", async () => {
    insertedIds.clear();
    rows.length = 0;
    await Promise.all([
      reconcileDeskGroupCreationAudit(input),
      reconcileDeskGroupCreationAudit(input),
    ]);
    expect(rows).toHaveLength(2);
    expect(insert).toHaveBeenCalled();
  });
});
