import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((destination: string): never => {
    throw { kind: "redirect", destination };
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));

import DashboardIndexPage from "./page";

describe("DashboardIndexPage", () => {
  it("routes the dashboard entry point through the canonical salon picker", () => {
    expect(() => DashboardIndexPage()).toThrow(
      expect.objectContaining({
        kind: "redirect",
        destination: "/choose-salon",
      }),
    );
  });
});
