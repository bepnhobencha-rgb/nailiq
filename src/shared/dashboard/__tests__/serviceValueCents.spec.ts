import { expect, it } from "vitest";
import { serviceValueCents } from "../serviceValueCents";

it.each([
  [{ price_cents: 4500, addon_price_cents: 1000 }, 5500],
  [{ price_cents: 4500, addon_price_cents: null }, 4500],
  [{ price_cents: null, addon_price_cents: 1000 }, 1000],
  [{ price_cents: null }, 0],
  [{ price_cents: Number.NaN, addon_price_cents: Infinity }, 0],
])("totals service and add-on value without inventing a payment %j", (row, value) => {
  expect(serviceValueCents(row)).toBe(value);
});
