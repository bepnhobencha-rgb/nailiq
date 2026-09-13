import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { readBookingAppearance, rememberBookingAppearance, useBookingRecoveryTheme } from "../bookingRecoveryAppearance";

const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const key = (id: string) => `nq:booking-appearance:v1:${id}`;
function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
}
describe("booking appearance is cosmetic and salon scoped", () => {
  it("renders a stable neutral server snapshot without browser storage", () => {
    function Shell() { return createElement("main", { style: useBookingRecoveryTheme(a) }); }
    expect(renderToString(createElement(Shell))).toContain("--booking-text:#1a1a1a");
  });
  it("keeps two salons separate through reload, including UUID case", () => {
    const s = storage();
    rememberBookingAppearance(s, { salonId: a, brandColor: "#D4AF37", themeMode: "dark" }, 1000);
    rememberBookingAppearance(s, { salonId: b, brandColor: "#112233", themeMode: "light" }, 1000);
    expect(readBookingAppearance(s, a.toUpperCase(), 2000)?.themeMode).toBe("dark");
    expect(readBookingAppearance(s, b, 2000)?.themeMode).toBe("light");
    expect(readBookingAppearance(s, a, 3601000)).toBeNull();
  });
  it("writes no contact, booking binding or card source", () => {
    const s = storage();
    rememberBookingAppearance(s, { salonId: a, brandColor: "#D4AF37", themeMode: "dark", sourceId: "SECRET", phone: "PRIVATE", bookingId: b } as Parameters<typeof rememberBookingAppearance>[1], 1000);
    const value = JSON.parse(s.getItem(key(a))!);
    expect(Object.keys(value).sort()).toEqual(["brandColor", "expiresAt", "salonId", "themeMode"]);
    expect(JSON.stringify(value)).not.toMatch(/SECRET|PRIVATE|bookingId/);
  });
  it.each([
    { salonId: b }, { brandColor: "red; background: url(https://invalid.example)" },
    { themeMode: "auto" }, { expiresAt: 0 }, { expiresAt: 99999999999 },
  ])("rejects tampered hints: %j", (patch) => {
    const s = storage();
    s.setItem(key(a), JSON.stringify({ salonId: a, brandColor: "#D4AF37", themeMode: "dark", expiresAt: 5000, ...patch }));
    expect(readBookingAppearance(s, a, 2000)).toBeNull();
  });
  it.each(["{", "null", "a".repeat(513)])("ignores malformed storage", raw => {
    const s = storage(); s.setItem(key(a), raw);
    expect(readBookingAppearance(s, a, 2000)).toBeNull();
  });
  it("tolerates denied storage and does not write invalid colors", () => {
    const denied = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("quota"); } };
    expect(() => rememberBookingAppearance(denied, { salonId: a, brandColor: "#D4AF37", themeMode: "dark" })).not.toThrow();
    expect(readBookingAppearance(denied, a)).toBeNull();
    const s = storage();
    rememberBookingAppearance(s, { salonId: a, brandColor: "url(secret)", themeMode: "dark" });
    expect(s.data.size).toBe(0);
  });
});
