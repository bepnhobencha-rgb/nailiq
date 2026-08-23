import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ segment: null as string | null }));
vi.mock("next/navigation", () => ({
  useSelectedLayoutSegment: () => mocks.segment,
}));

import { GuidedFocusVisibility } from "@/components/dashboard/GuidedFocusVisibility";

type GuidedFocusVisibilityProps = Parameters<typeof GuidedFocusVisibility>[0];
const TestGuidedFocusVisibility = GuidedFocusVisibility as (
  props: Omit<GuidedFocusVisibilityProps, "children"> & {
    children?: GuidedFocusVisibilityProps["children"];
  },
) => ReturnType<typeof GuidedFocusVisibility>;

describe("GuidedFocusVisibility", () => {
  beforeEach(() => {
    mocks.segment = null;
  });

  it("hides extra global CTAs throughout incomplete onboarding", () => {
    mocks.segment = "settings";
    expect(
      renderToStaticMarkup(
        createElement(TestGuidedFocusVisibility, {
          stage: "incomplete",
        }, createElement("a", { href: "/plans" }, "Extra CTA")),
      ),
    ).toBe("");
  });

  it("hides them on the completed root Action Center but restores nested operations", () => {
    const child = createElement("a", { href: "/plans" }, "Extra CTA");
    expect(
      renderToStaticMarkup(
        createElement(TestGuidedFocusVisibility, {
          stage: "complete",
        }, child),
      ),
    ).toBe("");

    mocks.segment = "center";
    expect(
      renderToStaticMarkup(
        createElement(TestGuidedFocusVisibility, {
          stage: "complete",
        }, child),
      ),
    ).toContain("Extra CTA");
  });

  it("leaves every legacy salon unchanged", () => {
    expect(
      renderToStaticMarkup(
        createElement(TestGuidedFocusVisibility, {
          stage: "disabled",
        }, createElement("span", null, "Legacy")),
      ),
    ).toContain("Legacy");
  });
});
