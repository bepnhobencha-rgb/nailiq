import { describe, expect, it, vi } from "vitest";
import { fetchAllVipRows, fetchVipRowsForIds } from "@/shared/ai/vipCareData";

describe("VIP Care paged data loading", () => {
  it("reads every page instead of stopping at the Supabase row cap", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: 1 }, { id: 2 }], error: null })
      .mockResolvedValueOnce({ data: [{ id: 3 }, { id: 4 }], error: null })
      .mockResolvedValueOnce({ data: [{ id: 5 }], error: null });

    const rows = await fetchAllVipRows("profiles", fetchPage, 2);

    expect(rows.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
    expect(fetchPage.mock.calls).toEqual([[0, 1], [2, 3], [4, 5]]);
  });

  it("fails closed when any page returns a database error", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: 1 }], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "database unavailable" } });

    await expect(fetchAllVipRows("visits", fetchPage, 1)).rejects.toThrow(
      "[vip_care:visits] database unavailable",
    );
  });

  it("rejects an invalid page size before querying", async () => {
    const fetchPage = vi.fn();

    await expect(fetchAllVipRows("profiles", fetchPage, 0)).rejects.toThrow(
      "page size must be a positive integer",
    );
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("bounds id batches and paginates one-to-many results", async () => {
    const fetchPage = vi.fn(async (ids: string[], from: number) => ({
      data: from === 0 ? ids.map((id) => ({ id })) : [],
      error: null,
    }));

    const rows = await fetchVipRowsForIds(
      "profiles",
      ["a", "b", "c", "c"],
      fetchPage,
      2,
    );

    expect(rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(fetchPage.mock.calls.map(([ids]) => ids)).toEqual([
      ["a", "b"],
      ["c"],
    ]);
  });
});
