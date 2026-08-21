import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ segment: null as string | null }));
vi.mock("next/navigation", () => ({
  useSelectedLayoutSegment: () => mocks.segment,
}));

import { GuidedFocusVisibility } from "@/components/dashboard/GuidedFocusVisibility";

describe("GuidedFocusVisibility", () => {
  beforeEach(() => {
    mocks.segment = null;
  });

  it("hides extra global CTAs throughout incomplete onboarding", () => {
    mocks.segment = "settings";
    expect(
      renderToStaticMarkup(
        createElement(GuidedFocusVisibility, {
          stage: "incomplete",
          children: createElement("a", { href: "/plans" }, "Extra CTA"),
        }),
      ),
    ).toBe("");
  });

  it("hides them on the completed root Action Center but restores nested operations", () => {
    const child = createElement("a", { href: "/plans" }, "Extra CTA");
    expect(
      renderToStaticMarkup(
        createElement(GuidedFocusVisibility, {
          stage: "complete",
          children: child,
        }),
      ),
    ).toBe("");

    mocks.segment = "center";
    expect(
      renderToStaticMarkup(
        createElement(GuidedFocusVisibility, {
          stage: "complete",
          children: child,
        }),
      ),
    ).toContain("Extra CTA");
  });

  it("leaves every legacy salon unchanged", () => {
    expect(
      renderToStaticMarkup(
        createElement(GuidedFocusVisibility, {
          stage: "disabled",
          children: createElement("span", null, "Legacy"),
        }),
      ),
    ).toContain("Legacy");
  });
});
