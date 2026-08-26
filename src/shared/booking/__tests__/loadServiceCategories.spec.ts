import { describe, expect, it, vi } from "vitest";

import {
  loadServiceCategoriesFromClient,
  type ServiceCategoryReadClient,
} from "@/shared/booking/loadServiceCategories";

function clientFor(result: { data: readonly unknown[] | null; error: unknown }) {
  const query = {
    is: vi.fn(),
    order: vi.fn(),
    then: (
      resolve: (value: typeof result) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  };
  query.is.mockReturnValue(query);
  query.order.mockReturnValue(query);
  const select = vi.fn(() => query);
  const from = vi.fn(() => ({ select }));
  return {
    client: { from } as unknown as ServiceCategoryReadClient,
    from,
    select,
    query,
  };
}

const rows = [
  { slug: "other", name_en: "Other", name_vi: "Khác", sort_order: null },
  { slug: "pedicure", name_en: "Pedicure", name_vi: "Móng chân", sort_order: 20 },
  { slug: "manicure", name_en: "Manicure", name_vi: "Móng tay", sort_order: 10 },
];

describe("loadServiceCategoriesFromClient", () => {
  it("loads only active taxonomy rows and sorts null positions last", async () => {
    const mock = clientFor({ data: rows, error: null });

    await expect(loadServiceCategoriesFromClient(mock.client)).resolves.toEqual([
      { slug: "manicure", nameEn: "Manicure", nameVi: "Móng tay", sortOrder: 10 },
      { slug: "pedicure", nameEn: "Pedicure", nameVi: "Móng chân", sortOrder: 20 },
      {
        slug: "other",
        nameEn: "Other",
        nameVi: "Khác",
        sortOrder: Number.MAX_SAFE_INTEGER,
      },
    ]);
    expect(mock.from).toHaveBeenCalledWith("service_categories");
    expect(mock.select).toHaveBeenCalledWith("slug, name_en, name_vi, sort_order");
    expect(mock.query.is).toHaveBeenCalledWith("deleted_at", null);
    expect(mock.query.order).toHaveBeenNthCalledWith(1, "sort_order", {
      ascending: true,
      nullsFirst: false,
    });
    expect(mock.query.order).toHaveBeenNthCalledWith(2, "slug", {
      ascending: true,
    });
  });

  it.each([
    [{ data: null, error: { code: "db_down" } }, "service_categories_unavailable"],
    [{ data: [], error: null }, "service_categories_empty"],
    [
      {
        data: [{ slug: "bad-slug", name_en: "Bad", name_vi: "Sai", sort_order: 1 }],
        error: null,
      },
      "service_category_invalid",
    ],
    [
      {
        data: [rows[1], { ...rows[1], name_en: "Duplicate" }],
        error: null,
      },
      "service_category_invalid",
    ],
  ] as const)("fails closed instead of flattening the catalog: %s", async (result, code) => {
    const mock = clientFor(result);
    await expect(loadServiceCategoriesFromClient(mock.client)).rejects.toThrow(code);
  });
});
